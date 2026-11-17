# 跨中间消息保持运行信息缩进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一轮助手回复中的运行信息跨越中间权限、状态和其他动作继续显示在同一个缩进活动摘要内。

**Architecture:** `mergeTurnActivities` 维护当前助手轮的一个活动摘要槽位。活动消息写入该槽位；非活动消息保持独立写入时间线；右侧用户消息结束槽位并开启下一轮。渲染组件和活动数据结构保持不变。

**Tech Stack:** React, TypeScript, Vitest, Testing Library.

---

### Task 1: Add the regression test

**Files:**
- Modify: `tests/unit/renderer/messageList.dom.test.tsx`

- [ ] **Step 1: Import the grouping helper**

Change the `MessageList` import to include the named helper:

```tsx
import MessageList, { mergeTurnActivities } from '@/renderer/pages/conversation/Messages/MessageList';
```

- [ ] **Step 2: Add a failing cross-message grouping test**

Add a test that passes `thinking`, an independent permission message, a preprocessed `tool_summary`, an independent agent status, a second thinking message, a right-side user message, and a final thinking message to `mergeTurnActivities`. Assert that the result types are:

```ts
['turn_activity_summary', 'permission', 'agent_status', 'text', 'turn_activity_summary']
```

Assert that the first summary contains `thinking`, `tools`, and `thinking` activities in that order, and the final summary contains only the post-user thinking message.

- [ ] **Step 3: Run the focused test and verify the expected failure**

Run from `AionUi`:

```powershell
bunx vitest run tests/unit/renderer/messageList.dom.test.tsx
```

Expected: the new test fails because the current helper flushes on every non-activity item and produces multiple activity summaries.

### Task 2: Keep one activity summary open per assistant turn

**Files:**
- Modify: `packages/desktop/src/renderer/pages/conversation/Messages/MessageList.tsx:156-192`

- [ ] **Step 1: Replace contiguous buffering with an active summary slot**

Maintain an `activeSummary` reference. On the first thinking/tool item, create and immediately push one `turn_activity_summary` object. Append subsequent activities to that object's arrays. Push non-activity items unchanged. Clear `activeSummary` when `item.position === 'right'`.

- [ ] **Step 2: Run the focused test and verify it passes**

Run:

```powershell
bunx vitest run tests/unit/renderer/messageList.dom.test.tsx
```

Expected: the new regression test and all existing MessageList tests pass.

### Task 3: Run targeted verification

**Files:**
- Verify: `packages/desktop/src/renderer/pages/conversation/Messages/MessageList.tsx`
- Verify: `tests/unit/renderer/messageList.dom.test.tsx`

- [ ] **Step 1: Run the focused renderer test**

```powershell
bunx vitest run tests/unit/renderer/messageList.dom.test.tsx tests/unit/renderer/messageTurnActivitySummary.dom.test.tsx
```

Expected: all tests pass with exit code 0.

- [ ] **Step 2: Run the desktop type check or repository check used by the package**

Inspect `AionUi/package.json` scripts and run the narrowest available TypeScript/lint check covering the desktop renderer. Expected: exit code 0 with no new diagnostics.

- [ ] **Step 3: Review the diff**

```powershell
git diff --check
git diff -- packages/desktop/src/renderer/pages/conversation/Messages/MessageList.tsx tests/unit/renderer/messageList.dom.test.tsx
```

Expected: only the activity grouping change and its regression test are present, with no whitespace errors.
