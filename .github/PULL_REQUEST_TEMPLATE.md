<!-- Thank you for contributing to Taimen Human Harness. One logical change per
     pull request; see CONTRIBUTING.md for the full guidelines. -->

## Summary

<!-- What changes and why. For a change to the tool contract (`cp_*`), the
     `/api/harness/*` or launcher routes, the bundle patch or environment variables, link the
     ADR or issue that proposes it. -->

## Checklist

- [ ] I have signed the Contributor License Agreement
      ([`cla/CLA-individual.md`](https://github.com/taimen-ai/taimen/blob/main/cla/CLA-individual.md)
      or [`cla/CLA-entity.md`](https://github.com/taimen-ai/taimen/blob/main/cla/CLA-entity.md)
      in the umbrella repository).
- [ ] The change contains no secrets, customer data or internal hostnames (in
      particular nothing from a `DSH_HOME` or `~/.config/iam`).
- [ ] `pnpm typecheck` and `pnpm test` pass (and `pnpm third-party --check`
      after a dependency change); behaviour changes come with vitest
      tests.
- [ ] A change to the tool contract (`cp_*`), the `/api/harness/*` or launcher
      routes, the bundle patch or environment variables references an ADR or issue and
      updates the README.
