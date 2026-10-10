#!/usr/bin/env python3

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

from lib.config import ConfigError, compact_json, load_json, object_value, repository_root, schema_v1
from lib.github import append_outputs, append_summary


CONFIDENCE = {"medium": 0, "certain": 1}
WORKLOADS = {
    "platform_build",
    "static_gate",
    "preflight",
}


class ScopeContract:
    def __init__(self, path: Path):
        value = object_value(load_json(path), "scopes")
        expected = {"schema", "effects", "matches", "rules"}
        if set(value) != expected:
            raise ConfigError(f"scopes keys must be {sorted(expected)}")
        schema_v1(value, "scopes")
        self.effects = self._string_list(value["effects"], "scopes.effects")
        if len(set(self.effects)) != len(self.effects):
            raise ConfigError("scopes.effects contains duplicates")
        self.matches = object_value(value["matches"], "scopes.matches")
        self.rules = value["rules"]
        self._validate()

    @staticmethod
    def _string_list(value, label):
        if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
            raise ConfigError(f"{label} must be an array of non-empty strings")
        return value

    def _validate_match(self, match, label, stack=()):
        match = object_value(match, label)
        allowed = {"prefixes", "exact", "regexes", "include", "exclude"}
        if not set(match) <= allowed:
            raise ConfigError(f"{label} has unsupported keys {sorted(set(match) - allowed)}")
        for field in ("prefixes", "exact", "regexes", "include", "exclude"):
            if field in match:
                values = self._string_list(match[field], f"{label}.{field}")
                for token in values:
                    if field in {"include", "exclude"}:
                        self._validate_token(token, f"{label}.{field}", stack)
                    elif field == "regexes":
                        try:
                            re.compile(token)
                        except re.error as error:
                            raise ConfigError(f"invalid regex {token!r} in {label}: {error}") from error

    def _validate_token(self, token, label, stack):
        if token.startswith("match://"):
            name = token.removeprefix("match://")
            if name not in self.matches:
                raise ConfigError(f"{label} references unknown match {name}")
            if name in stack:
                raise ConfigError(f"match cycle: {' -> '.join((*stack, name))}")
            self._validate_match(self.matches[name], f"scopes.matches.{name}", (*stack, name))
        elif not token.startswith("prefix://"):
            raise ConfigError(f"{label} has unsupported token {token}")

    def _validate(self):
        for name, match in self.matches.items():
            if not isinstance(name, str) or not name:
                raise ConfigError("scopes.matches keys must be non-empty strings")
            self._validate_match(match, f"scopes.matches.{name}", (name,))
        if not isinstance(self.rules, list) or not self.rules:
            raise ConfigError("scopes.rules must be a non-empty array")
        seen = set()
        for index, rule in enumerate(self.rules):
            rule = object_value(rule, f"scopes.rules[{index}]")
            allowed = {"id", "match", "effects", "confidence"}
            if not set(rule) <= allowed or not {"id", "match", "effects", "confidence"} <= set(rule):
                raise ConfigError(f"scopes.rules[{index}] has invalid keys")
            rule_id = rule["id"]
            if not isinstance(rule_id, str) or not rule_id or rule_id in seen:
                raise ConfigError(f"invalid or duplicate scope rule id {rule_id!r}")
            seen.add(rule_id)
            self._validate_match(rule["match"], f"scopes.rules.{rule_id}.match")
            effects = self._string_list(rule["effects"], f"scopes.rules.{rule_id}.effects")
            unknown = set(effects) - set(self.effects)
            if unknown:
                raise ConfigError(f"scope rule {rule_id} has unknown effects {sorted(unknown)}")
            if rule["confidence"] not in CONFIDENCE:
                raise ConfigError(f"scope rule {rule_id} has invalid confidence")

    def _token_matches(self, file, token):
        if token.startswith("match://"):
            return self.match(file, self.matches[token.removeprefix("match://")])
        return file.startswith(token.removeprefix("prefix://"))

    def match(self, file, match):
        positives = []
        positives.extend(file.startswith(prefix) for prefix in match.get("prefixes", []))
        positives.extend(file == exact for exact in match.get("exact", []))
        positives.extend(re.search(pattern, file) is not None for pattern in match.get("regexes", []))
        positives.extend(self._token_matches(file, token) for token in match.get("include", []))
        if positives and not any(positives):
            return False
        if any(self._token_matches(file, token) for token in match.get("exclude", [])):
            return False
        return True


def empty_effects(contract):
    return {effect: False for effect in contract.effects}


def evaluate(contract, files, threshold):
    outputs = empty_effects(contract)
    decisions = []
    for file in files:
        matched = [rule for rule in contract.rules if contract.match(file, rule["match"])]
        matched_ids = [rule["id"] for rule in matched]
        if not matched:
            outputs = {effect: True for effect in contract.effects}
            decisions.append({"file": file, "matchedRules": [], "escalated": True, "reason": "unmatched"})
            continue
        if any(CONFIDENCE[rule["confidence"]] < CONFIDENCE[threshold] for rule in matched):
            outputs = {effect: True for effect in contract.effects}
            decisions.append({"file": file, "matchedRules": matched_ids, "escalated": True, "reason": "below-threshold"})
            continue
        for rule in matched:
            for effect in rule["effects"]:
                outputs[effect] = True
        decisions.append({"file": file, "matchedRules": matched_ids, "escalated": False})
    return outputs, decisions


def enabled_workloads(outputs, ci_mode, full_lanes):
    any_scope = any(outputs.values())
    broad = full_lanes or ci_mode == "hot" or any_scope
    enabled = {
        "platform_build": broad,
        "static_gate": True,
        "preflight": True,
    }
    if set(enabled) != WORKLOADS:
        raise AssertionError("scope workload map drifted")
    return enabled, broad


def build_plan(contract, files, source, threshold, ci_mode, full_lanes, resolved=True):
    if threshold is None:
        outputs = {effect: True for effect in contract.effects}
        decisions = []
    else:
        outputs, decisions = evaluate(contract, files, threshold)
    enabled, broad = enabled_workloads(outputs, ci_mode, full_lanes)
    hits = Counter(rule for decision in decisions for rule in decision["matchedRules"])
    scopes = {
        **outputs,
        "ci_mode": ci_mode,
        "run_preflight_typecheck": broad,
    }
    return {
        "schemaVersion": 1,
        "source": source,
        "scopes": scopes,
        "enabled": enabled,
        "trace": {
            "threshold": threshold or "none",
            "filesResolved": resolved,
            "fileCount": len(files) if resolved else 0,
            "ruleHits": dict(hits),
            "escalations": [
                {"file": item["file"], "reason": item["reason"]}
                for item in decisions if item["escalated"]
            ],
        },
    }


def required_env(name):
    value = os.environ.get(name)
    if not value:
        raise ConfigError(f"{name} is required")
    return value


def event_payload():
    return load_json(Path(required_env("GITHUB_EVENT_PATH")))


def run_gh(args):
    override = os.environ.get("OPEN_DESIGN_GH_NODE_SCRIPT")
    command = (["node", override] if override else ["gh"]) + args
    return subprocess.run(command, check=True, text=True, stdout=subprocess.PIPE).stdout


def changed_files_for_environment():
    event_name = required_env("GITHUB_EVENT_NAME")
    repository = required_env("GITHUB_REPOSITORY")
    event = event_payload()
    if event_name == "pull_request":
        number = event.get("pull_request", {}).get("number")
        if number is None:
            raise ConfigError("pull_request.number is required")
        output = run_gh(["api", "--paginate", f"repos/{repository}/pulls/{number}/files", "--jq", ".[] | .filename, (.previous_filename // empty)"])
        return event_name, output.splitlines(), "medium", "hot", False, True
    if event_name == "workflow_dispatch":
        mode = event.get("inputs", {}).get("ci_mode", "full")
        if mode not in {"hot", "full"}:
            raise ConfigError(f"unsupported workflow_dispatch ci_mode: {mode}")
        if mode == "hot":
            sha = required_env("GITHUB_SHA")
            output = run_gh(["api", "--paginate", f"repos/{repository}/compare/main...{sha}", "--jq", "(.files // [])[] | .filename, (.previous_filename // empty)"])
            return "workflow_dispatch:hot", output.splitlines(), "medium", "hot", False, False
        return event_name, [], None, "full", True, False
    if event_name == "merge_group":
        group = event.get("merge_group", {})
        base, head = group.get("base_sha"), group.get("head_sha")
        if not base or not head:
            raise ConfigError("merge_group base_sha and head_sha are required")
        try:
            comparison = json.loads(run_gh(["api", f"repos/{repository}/compare/{base}...{head}"]))
            records = comparison.get("files", [])
            if len(records) >= 300:
                raise ConfigError("merge_group comparison reached the 300-file ceiling")
            files = [name for record in records for name in (record.get("filename"), record.get("previous_filename")) if isinstance(name, str)]
            if not files:
                return "merge_group:empty-resolution", [], None, "full", True, True
            return event_name, files, "certain", "full", False, True
        except (subprocess.SubprocessError, json.JSONDecodeError, ConfigError) as error:
            print(f"::warning::merge_group resolution failed; using full plan: {error}", file=sys.stderr)
            return "merge_group:resolution-error", [], None, "full", True, True
    return event_name, [], None, "full", True, False


def emit_plan(plan, output_path=None):
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    append_outputs({
        "enabled": compact_json(plan["enabled"]),
        "scopes": compact_json(plan["scopes"]),
    })
    trace = plan["trace"]
    lines = [
        "### Scope decision trace", "",
        f"- source: `{plan['source']}`, trust threshold: `{trace['threshold']}`",
        f"- files: {trace['fileCount'] if trace['filesResolved'] else 'not resolved'}, escalated: {len(trace['escalations'])}",
    ]
    if trace["ruleHits"]:
        lines += ["", "| Rule | Hits |", "| --- | ---: |"]
        lines += [f"| {name} | {count} |" for name, count in sorted(trace["ruleHits"].items(), key=lambda item: -item[1])]
    append_summary("\n".join(lines))
    print("scope decision trace:\n" + json.dumps(trace, indent=2, sort_keys=True))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    github = sub.add_parser("github-output")
    github.add_argument("--output", type=Path)
    plan = sub.add_parser("plan")
    plan.add_argument("--context", choices=("pr", "merge-queue", "full"), default="pr")
    plan.add_argument("--files", nargs="*", default=[])
    plan.add_argument("--files-from")
    sub.add_parser("validate")
    sub.add_parser("rules")
    return parser.parse_args()


def main():
    root = repository_root(__file__)
    args = parse_args()
    contract = ScopeContract(args.config or root / ".github/config/scopes.json")
    if args.command == "validate":
        print("scope configuration is valid")
        return 0
    if args.command == "rules":
        for rule in contract.rules:
            print(f"{rule['id']}\n  confidence: {rule['confidence']}\n  effects: {', '.join(rule['effects']) or '(none)'}")
        return 0
    if args.command == "github-output":
        source, files, threshold, mode, full_lanes, resolved = changed_files_for_environment()
        plan = build_plan(contract, files, source, threshold, mode, full_lanes, resolved)
        selection = os.environ.get("CI_WORKLOADS", "").strip()
        if selection:
            if os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
                raise ConfigError("explicit workload selection requires workflow_dispatch")
            requested = set(selection.split(","))
            if not requested.issubset(WORKLOADS):
                raise ConfigError("explicit selection contains unknown workload identities")
            plan["enabled"] = {name: name in requested for name in WORKLOADS}
            plan["source"] = "workflow_dispatch:selected"
            plan["selection"] = sorted(requested)
        emit_plan(plan, args.output)
        return 0
    files = list(args.files)
    if args.files_from:
        content = sys.stdin.read() if args.files_from == "-" else Path(args.files_from).read_text(encoding="utf-8")
        files += [line for line in content.splitlines() if line]
    if args.context == "full":
        settings = (None, "full", True, False)
    elif args.context == "merge-queue":
        settings = ("certain", "full", False, True)
    else:
        settings = ("medium", "hot", False, True)
    threshold, mode, full_lanes, resolved = settings
    print(json.dumps(build_plan(contract, files, f"cli:{args.context}", threshold, mode, full_lanes, resolved), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigError as error:
        print(f"scope configuration error: {error}", file=sys.stderr)
        raise SystemExit(2)
