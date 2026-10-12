import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = yaml.safe_load((ROOT / ".github/workflows/secret-scan.yml").read_text())
STEPS = {step.get("name"): step for step in WORKFLOW["jobs"]["gitleaks"]["steps"]}
ZERO = "0" * 40


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class SecretScanWorkflow(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one")
        self.base = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "two")
        self.head = git(self.repo, "rev-parse", "HEAD")

    def run_step(self, name, env):
        output = self.root / "output"
        output.write_text("")
        full_env = {**os.environ, **env, "GITHUB_OUTPUT": str(output)}
        result = subprocess.run(["bash", "-c", STEPS[name]["run"]], cwd=self.repo, env=full_env, capture_output=True, text=True)
        return result, output.read_text()

    def resolve(self, event, full="false", **shas):
        env = {"FULL_HISTORY": full, "EVENT_NAME": event, "HEAD_SHA": self.head, "PUSH_BEFORE": "", "PR_BASE_SHA": "", "MERGE_GROUP_BASE_SHA": "", **shas}
        result, output = self.run_step("Resolve scan range", env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return output.strip()

    def test_push_scans_only_the_pushed_range(self):
        self.assertEqual(self.resolve("push", PUSH_BEFORE=self.base), f"log-opts={self.base}..{self.head}")

    def test_pull_request_and_merge_group_scan_from_their_base(self):
        self.assertEqual(self.resolve("pull_request", PR_BASE_SHA=self.base), f"log-opts={self.base}..{self.head}")
        self.assertEqual(self.resolve("merge_group", MERGE_GROUP_BASE_SHA=self.base), f"log-opts={self.base}..{self.head}")

    def test_new_branch_unknown_base_and_schedule_scan_everything_reachable(self):
        self.assertEqual(self.resolve("push", PUSH_BEFORE=ZERO), f"log-opts={self.head}")
        self.assertEqual(self.resolve("push", PUSH_BEFORE="1" * 40), f"log-opts={self.head}")
        self.assertEqual(self.resolve("schedule"), f"log-opts={self.head}")

    def test_full_history_overrides_the_range(self):
        self.assertEqual(self.resolve("push", full="true", PUSH_BEFORE=self.base), "log-opts=--all")

    def fake_gitleaks(self, exit_code):
        bin_dir = self.root / "bin"
        bin_dir.mkdir(exist_ok=True)
        fake = bin_dir / "gitleaks"
        fake.write_text(f'#!/usr/bin/env bash\necho "$@" > "{self.root}/args"\nexit {exit_code}\n')
        fake.chmod(0o755)
        return {"PATH": f"{bin_dir}:{os.environ['PATH']}"}

    def scan(self, exit_code, fail="true"):
        env = {**self.fake_gitleaks(exit_code), "LOG_OPTS": f"{self.base}..{self.head}", "FAIL_ON_FINDINGS": fail}
        result, _ = self.run_step("Run gitleaks", env)
        return result, (self.root / "args").read_text()

    def test_findings_fail_by_default_and_warn_in_shadow(self):
        clean, args = self.scan(0)
        self.assertEqual(clean.returncode, 0)
        self.assertIn(f"--log-opts={self.base}..{self.head}", args)
        self.assertIn("--redact=100", args)
        self.assertNotIn("--config", args)
        self.assertEqual(self.scan(1)[0].returncode, 1)
        shadow, _ = self.scan(1, fail="false")
        self.assertEqual(shadow.returncode, 0)
        self.assertIn("::warning::", shadow.stdout)

    def test_consumer_config_is_used_when_present(self):
        (self.repo / ".gitleaks.toml").write_text("[extend]\nuseDefault = true\n")
        self.assertIn("--config=.gitleaks.toml", self.scan(0)[1])

    def test_contract_is_least_privilege_and_pinned(self):
        self.assertEqual(WORKFLOW["permissions"], {})
        self.assertEqual(WORKFLOW["jobs"]["gitleaks"]["permissions"], {"contents": "read"})
        inputs = WORKFLOW[True]["workflow_call"]["inputs"]
        self.assertEqual((inputs["full-history"]["default"], inputs["fail-on-findings"]["default"]), (False, True))
        for step in WORKFLOW["jobs"]["gitleaks"]["steps"]:
            if "uses" in step:
                self.assertRegex(step["uses"], r"@[0-9a-f]{40}$")
        self.assertRegex(STEPS["Install pinned gitleaks"]["env"]["GITLEAKS_SHA256"], r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
