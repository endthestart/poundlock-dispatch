# Poundlock Dispatch

Separate Poundlock client. GUI first. Pi 1.1.0 only.

- Manager plans, delegates to interactive workers, and reviews. It does not write the user’s repo.
- Do not give the manager shell, write, or patch-authoring tools.
- Local sub-agents may write project files via Pi and Poundlock `/v1`. Durable Poundlock jobs are for manual use (`dispatch jobs`); Dispatch never routes a task to one (ADR 016).
- Manager-only notes live in Poundlock Dispatch’s data directory, not the user’s repo.
- Do not read Poundlock’s database or bypass jobs with SSH/Docker.
- Do not copy credentials into this repository.
- Adding a project is a folder path or a Git HTTPS URL. Do not snapshot the tree at create.
