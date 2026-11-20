# pi-toolkit

Extensions for the Pi coding agent, split by where they change things: rendering extensions change only how a conversation is displayed, agent extensions change the agent's tools, prompt, or behavior. Each extension owns one directory, works on its own, and can be installed alone. Session data, config, and tool implementations stay untouched.

The rendering extensions aim to read a turn in fewer lines, then expand when you need detail.

Version and dependency scope: see [Compatibility](#compatibility).

[中文](README.md) | English

## What it looks like

![A request collapsed into a single summary line](assets/hero-collapsed.png)

This screen layers three rendering extensions: `minimal-tools`, `message-marks`, and `tool-run-groups`.

<details>
<summary>Expanded timeline</summary>

![The same request expanded with Ctrl+O](assets/hero-expanded.png)

</details>

## Extensions

### Rendering

`extensions/render/`, display only.

| Extension | What it does |
|---|---|
| [minimal-tools](extensions/render/minimal-tools/README.md) | How tool calls are displayed: visible while running, one line when done |
| [message-marks](extensions/render/message-marks/README.md) | A 2-column gutter shared by user, assistant, and tools |
| [tool-run-groups](extensions/render/tool-run-groups/README.md) | Collapses a request's tool calls into one summary line |

### Agent behavior

`extensions/agent/`, the agent's tools, prompt, and behavior.

| Extension | What it does |
|---|---|
| [skill-tool](extensions/agent/skill-tool/README.md) | Turns skill loading into a dedicated tool, with the catalog in its description |
| [subagent](extensions/agent/subagent/README.md) | Hands research work to a subagent in its own context; only the conclusion comes back |

How to pick: an extension that only changes display is rendering; one that changes the agent's tools, prompt, or behavior is agent.

Behavior, keybindings, implementation notes, and limits live in each directory's README instead of here. A new category directory needs a `package.json` that lists its entry points under `pi.extensions` and sets `"type": "module"`: Pi discovers extensions one level deep and skips a category directory without that manifest, and without the module type `moduleResolution: NodeNext` parses the directory as CommonJS.

## Getting started

### Install

```bash
pi install git:github.com/DuskWander87/pi-toolkit
```

One command installs every extension under `extensions/`. Check with `pi list`, then run `/reload` inside Pi or restart the session.

To install a local clone instead:

```bash
git clone https://github.com/DuskWander87/pi-toolkit
pi install ./pi-toolkit
```

Run the second command from the directory that contains the clone; an absolute path works too.

### Keep only some extensions

```bash
pi config
```

Disable the extensions you do not want. The change applies on the next start.

### Try without saving config

```bash
pi -e ./pi-toolkit
```

`-e` applies to one launch and is cached under `~/.pi/agent/tmp/extensions/`. Run it from the directory that contains the clone, as with the install command above.

### Update and uninstall

```bash
pi update --extensions
pi remove git:github.com/DuskWander87/pi-toolkit
```

## Compatibility

- Verified against Pi 1.5.2; other versions are not promised
- Every extension depends on Pi internals in its own place, so a Pi upgrade may degrade or break them. Each README lists its own dependency points under its 边界 (boundaries) or 限制 (limits) section

## Tests

```bash
npm test
npm run typecheck
```

`npm run typecheck` runs TypeScript through npx; the first run needs network access and nothing is written to `node_modules`.

Tests need `jiti`, `chalk`, and the two host packages; `typebox` is a devDependency in `package.json` and lands at the top of `node_modules` along with the host packages. The type check also needs `@types/node` (it ships as a development dependency of the host packages, so it is not pulled in by the command above). On a fresh clone without `node_modules`, install them without touching `package.json`:

```bash
npm install --no-save --no-package-lock @earendil-works/pi-coding-agent@1.5.2 @earendil-works/pi-tui@1.5.2 jiti chalk @types/node
```

Skip this step when `node_modules` already points at your Pi installation.

Tests live under `test/`, mirroring the `extensions/` directories (`test/render/*.test.ts`, `test/agent/*.test.ts`): one file per extension, with the covered cases spelled out in the case names; `test/integration.test.ts` covers several extensions installed together.

## License

[MIT](LICENSE)
