# Project conventions

Treat code and documentation as suitable for a public repository. Write them in English.
Keep personal paths, credentials, and internal working notes out of tracked artifacts.
The project uses the MIT license. Publication requires explicit owner confirmation immediately before execution.
Use Node built-ins for the local CLI and tests. Ask before adding dependencies.
Keep issue behavior shared across SQLite and D1. Verify field-level conflicts through real database operations.
Never write pd issue ids, such as `pd-149`, into commit messages, CHANGELOG.md, or CHANGELOG.human.md. Only the owner's agents can read pd, so describe changes in words; the `tip:` comment on the pd issue links it to git.
Use cf for Cloudflare workflows. Do not deploy, commit, or push without user authorization.
