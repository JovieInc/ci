# Repository documentation parity

Decision (2026-09-24): COMPOSE Git-owned Markdown, existing repository freshness
checks, SHA-pinned file projections and repo-local manifests. Extend JOV-6555's
independent distribution boundary without replacing its shared-workflow work.

The MIT-licensed `scripts/repository_docs.py` uses only Python 3.9+ stdlib. It
fetches nothing, executes no imports, needs no credentials and changes no service.
Consumers vendor the exact script and license using a full revision and SHA-256.
`repository-docs.json` names local entry points, manifest/workflow sources, output
and shared imports. Package facts are rendered directly; other sources have
fingerprints. A fingerprint is a review trigger, not proof of prose accuracy.

## Update, verify and roll back

1. Review the upstream commit and preserve the known-good consumer commit.
2. Update the selected import's full Git revision and SHA-256 in the registry.
3. From the reviewed tooling checkout run:

   ```sh
   python3 scripts/repository_docs.py --root /path/to/consumer --write \
     --upstream JovieInc/ci=/path/to/ci \
     --upstream JovieInc/Jovie=/path/to/Jovie
   ```

4. Review the diff and run the vendored `python3 scripts/repository_docs.py`.
5. Open an independently checked consumer PR. Revert that consumer commit to
   roll back; sibling repos retain their pins and continue shipping.

All source hashes are validated before writes. Only listed imports and the
projection are written. README and AGENTS stay locally owned. Without upstream
arguments the check proves offline parity to the declared pin, not freshness of
the pin or remote availability. Update-time Git readback proves source bytes.
After a local manifest/workflow edit, review its documentation and regenerate
with `python3 scripts/repository_docs.py --write` in the consumer.

## Qualification

Run `python3 -m coverage run --branch --source=scripts -m unittest discover -s tests -p test_repository_docs.py -v`
and `python3 -m coverage report --show-missing --fail-under=100`.
Tests cover source drift, absent entry points, path escape, bad pins, independent
upgrades and rollback. Consumer CI uses `continue-on-error` during shadow
qualification. Do not require it in branch protection. Promotion requires actual
ship samples, correctness/pass rate, p95 duration, throughput/cost and failure
isolation, an accountable owner and a tested rollback. No numeric promotion
threshold is asserted here. Existing gates remain enforced.

## Adopt-first receipt

- Preserve Jovie's existing `scripts/lib/doc-freshness.mjs` for local links and
  computed markers, and JOV-6555 for pinned CI releases and consumer canaries.
- GitHub [reusable workflows and composite actions](https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations)
  are the maintained CI substrate; they do not render offline repo docs.
- [Copier template updates](https://copier.readthedocs.io/en/stable/generating/)
  were evaluated but not adopted: whole-project templating is unnecessary for
  a few shared files in independently maintained repositories.
- Custom code is limited to offline projection and exact-byte copy verification.
  No new service catalog, platform, scheduler, updater bot or paid service.
  Only reviewed non-secret policy and tool files cross repository boundaries.
  Git and ordinary files preserve portability and independent rollback.

Ship now: shadow checks in separate consumer PRs. Re-evaluate after two update
cycles with repeated drift or substantial manual work. Then extend the existing
updater under JOV-6555 rather than creating a second bot.
