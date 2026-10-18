/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 待办事项数据契约。
 *
 * 同一份 todo.json 由两个写入方共享:Electron 主进程(todoStore,UI 操作)
 * 和 todo MCP 子进程(agent 调用)。双方各自实现了相同的「mkdir 锁 + 临时文件
 * rename」原子写协议,字段契约以本文件为准;MCP 侧是零依赖 JS,按同样结构
 * 手写镜像。
 *
 * The todo.json file has two writers: the Electron main process (UI actions)
 * and the todo MCP child process (agent calls). Both implement the same
 * mkdir-lock + tmp-rename atomic write protocol. This file is the contract;
 * the dependency-free MCP script mirrors it by hand.
 */

export type TodoStatus = 'pending' | 'waiting' | 'done';
export type TodoSource = 'manual' | 'email' | 'agent';

/** 执行步骤拆解:卡片显示进度,详情抽屉里可直接勾选。 */
export interface ITodoSubtask {
  id: string;
  text: string;
  done: boolean;
}

/** 邮件来源引用:由邮件扫描创建的待办携带,用于溯源与按 Message-ID 去重。 */
export interface TodoEmailRef {
  message_id: string;
  subject: string;
  from: string;
  received_at: number;
}

export interface ITodoItem {
  id: string;
  title: string;
  notes?: string;
  /** 截止/完成节点,epoch 毫秒;无日期为 null。 */
  due_at?: number | null;
  status: TodoStatus;
  /** status=waiting 时的阻塞原因(待客户/上下游回复等),详情抽屉展示。 */
  blocked_reason?: string;
  /** 要求人/发起人显示名;邮件待办缺省取 email_ref.from。 */
  requester?: string;
  /** 执行步骤拆解。 */
  subtasks?: ITodoSubtask[];
  completed_at?: number | null;
  source: TodoSource;
  email_ref?: TodoEmailRef | null;
  created_at: number;
  updated_at: number;
}

export interface TodoStoreData {
  version: 1;
  todos: ITodoItem[];
  /** 已被邮件扫描消化过的 Message-ID,防重复建待办。 */
  processed_message_ids: string[];
  last_scan_at?: number | null;
  last_scan_status?: string | null;
}

/** 邮件快照单条(由邮件源适配器产出,MCP 的 email_snapshot_read 读取)。 */
export interface EmailSnapshotItem {
  message_id: string;
  subject: string;
  from_name?: string;
  from_address?: string;
  received_at: number;
  folder?: string;
  body_preview: string;
  unread?: boolean;
}

export interface EmailSnapshot {
  fetched_at: number;
  source: string;
  error?: string;
  emails: EmailSnapshotItem[];
}

export type TodoScanResult = {
  ok: boolean;
  message: string;
  emails_fetched?: number;
  conversation_id?: string;
  job_id?: string;
};

/** A persisted conversation created by an email scan run. */
export interface TodoScanSession {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  status?: string;
}

export type TodoStatusInfo = {
  last_scan_at: number | null;
  last_scan_status: string | null;
  source_ready: boolean;
  source_message: string;
};
