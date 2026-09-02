# gator-tools

Tooling shared across repositories, vendored as a Git submodule rather than
copied. One clone, one version, one place to fix a bug.

| | |
| --- | --- |
| [`skills/multi-agent-coordination`](skills/multi-agent-coordination/SKILL.md) | Coordinate several coding agents over one repository: joins, presence leases, exclusive file claims, named-reviewer quorums, blocking design questions, handoffs, and commit-pinned merge gates. Local Git backend by default; Redis Streams when agents are on different machines. |
| [`scripts/check-syntax.mjs`](scripts/check-syntax.mjs) | Parse every JavaScript file under the given roots and fail on the first syntax error. A gate, not a linter. |

## Installing in a project

```sh
git submodule add https://github.com/ShubhendraGautam/gator-tools gator-tools
git commit -m "chore: vendor gator-tools"
```

Cloning a project that uses it:

```sh
git clone --recurse-submodules <project>
# or, in an existing clone:
git submodule update --init --recursive
```

Updating to the latest tooling, deliberately, in the consuming project:

```sh
git -C gator-tools pull origin main
git add gator-tools && git commit -m "chore: update gator-tools"
```

A submodule pins an exact commit. That is the point: tooling does not change
under a project because someone pushed here, and updating is a commit in the
consuming repository with a diff you can read.

## Using the coordination skill

The skill resolves its own scripts relative to `SKILL.md`, so it runs from
wherever the submodule is mounted. Run it with the *consuming* repository as the
working directory:

```sh
node gator-tools/skills/multi-agent-coordination/scripts/coord.mjs init \
  --backend local --project my-project --base main \
  --integrator maintainer --queue TASKS.md --review-quorum 1
```

Point your agent instructions — `AGENTS.md`, `CLAUDE.md`, or `.claude/` — at
that path so an agent finds it without being told each session.

State lives under the consuming repository's `.git/multi-agent-coordination/`,
never here. Nothing in this repository is written to at runtime.

## Scope

Something belongs here when it is useful to more than one repository and carries
no assumption about the project around it. Anything that encodes one project's
goals, queue format, or review policy belongs in that project.

The coordination skill is a cooperation and audit tool, not an authentication
boundary. Agent names are self-asserted, and a process with repository
credentials can impersonate another agent. It gives a human an auditable record
of conduct; it does not prove identity.

## Licence

[Apache-2.0](LICENSE).
