# Package Skill as AionUi Built-in Assistant

Convert a skill into a wired AionUi built-in assistant preset, or update an existing one.

> **Architecture Note**: Built-in skills and built-in assistants are owned by the **`aioncore`** backend repository (`crates/aionui-app/assets/builtin-skills/` and `crates/aionui-app/assets/builtin-assistants/`), not `packages/desktop/`. Desktop-bundled MCP skills (such as `woody-codebase-memory`) live in `resources/bundled-mcp/<bundle>/skills/`. See `patches/README.md` for releasing a new `aioncore` tag and bumping `aioncoreVersion` in `package.json`.

## Usage

```
/package-assistant <skill-source-dir> [assistant-id] [avatar]
```

- `<skill-source-dir>` — Path to the source skill directory containing `SKILL.md` (e.g. `<officecli-repo>/skills/officecli-docx`)
- `[assistant-id]` — Optional. ID for the new assistant (defaults to `<skill-name>-creator`)
- `[avatar]` — Optional. Emoji or `avatars/<id>.jpg` asset path

Arguments: $ARGUMENTS

---

## Before You Start — Detect Mode

In your local `aioncore` checkout:

1. Check if `crates/aionui-app/assets/builtin-skills/<skill-name>/` exists
2. Check if the `assistant-id` already appears in `crates/aionui-app/assets/builtin-assistants/manifest.json`

- **Both exist** → **Update mode**: Only re-copy skill files (Step 1). Skip Steps 2–4.
- **Neither exists** → **New mode**: Run all steps (1–5).
- **Skill exists but assistant doesn't** (or vice versa) → Run whichever steps are missing.

---

## Step 1 — Copy Skill Files

1. Read all files from `<skill-source-dir>/` (`SKILL.md`, `creating.md`, `editing.md`, `reference/`, etc.)
2. Create target directory at `crates/aionui-app/assets/builtin-skills/<skill-name>/` — **directory name must match the skill `name` exactly**
3. Copy all files, applying these checks to `SKILL.md`:
   - **Remove version comments** inside YAML frontmatter so frontmatter parses cleanly.
   - **Verify `name` field matches directory name** (`name` and `description` are required).
   - **Keep BEFORE YOU START section** if the skill wraps an external CLI (e.g. `officecli`).
4. Copy companion markdown and reference files as-is (do not include symlinks or oversized binaries).

## Step 2 — Research the Skill (New Mode Only)

1. **Read the full skill content** to understand what it uniquely does.
2. **Identify differentiators**: Ensure `description_i18n` clearly distinguishes this assistant from other built-in assistants.
3. **Prepare self-contained example prompts**: Prompts must work immediately when clicked without requiring pre-existing user attachments.

## Step 3 — Create Assistant Rule Files (New Mode Only)

Create localized rule files in `crates/aionui-app/assets/builtin-assistants/rules/`:

- `rules/<assistant-id>.en-US.md` (English)
- `rules/<assistant-id>.zh-CN.md` (Simplified Chinese)

Instruct the assistant to load `<skill-name>` (and any companion skills such as `woody-codebase-memory` when applicable) and follow its workflow.

## Step 4 — Add Manifest Entry (New Mode Only)

Add a new entry to `crates/aionui-app/assets/builtin-assistants/manifest.json`:

```json
{
  "id": "<assistant-id>",
  "sort_order": 85,
  "default_enabled": false,
  "name": "<English Name>",
  "name_i18n": {
    "en-US": "<English Name>",
    "zh-CN": "<Chinese Name>"
  },
  "description": "<English description>",
  "description_i18n": {
    "en-US": "<English description>",
    "zh-CN": "<Chinese description>"
  },
  "avatar": "<emoji or avatars/<assistant-id>.jpg>",
  "agent_ref": "aionrs",
  "enabled_skills": ["<skill-name>"],
  "custom_skill_names": [],
  "disabled_builtin_skills": [],
  "rule_file": "rules/<assistant-id>.{locale}.md",
  "prompts": ["<Prompt 1>", "<Prompt 2>", "<Prompt 3>"],
  "prompts_i18n": {
    "en-US": ["<Prompt 1>", "<Prompt 2>", "<Prompt 3>"],
    "zh-CN": ["<中文提示 1>", "<中文提示 2>", "<中文提示 3>"]
  }
}
```

> **Note**: Built-in assistants use `"agent_ref": "aionrs"` as the default engine. If a legacy unprefixed slug existed prior to backend migration, ensure `PRESET_ID_WHITELIST` in `packages/desktop/src/process/utils/migrateAssistants.ts` stays compatible.

## Step 5 — Verify

1. Confirm `SKILL.md` frontmatter starts with `---` on line 1 and defines `name` and `description`.
2. Confirm both `en-US` and `zh-CN` rule files exist and are referenced by `rule_file`.
3. Run `cargo test` in `aioncore` (validating built-in manifest, skills, avatars, and localized rules).
4. Once a new `aioncore` release tag is published, update `aioncoreVersion` in this repository's `package.json` (see `.claude/skills/bump-version/SKILL.md`).
