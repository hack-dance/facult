#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runtime = require("./fclt-runtime.cjs");

const DEFAULT_TIMEOUT_MS = Number(process.env.FCLT_MCP_TIMEOUT_MS || 60_000);
const ACTIVITY_ACTION_DECIDE_CAPABILITY = "activity-action-decide-v1";
const ACTIVITY_ACTION_RESOLVE_CAPABILITY = "activity-action-resolve-v1";
const AUDIT_READ_ONLY_CAPABILITY = "audit-read-only-v1";
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;
const PLUGIN_ROOT = path.resolve(__dirname, "..");

const tools = [
  {
    name: "fclt_setup",
    description:
      "Bootstrap or repair the global fclt loop and optionally return an exact no-write project enrollment plan.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["global", "global_and_project"],
        },
        cwd: { type: "string" },
        dryRun: { type: "boolean" },
        installCodexPlugin: { type: "boolean" },
        approve: { type: "boolean" },
      },
      required: ["scope"],
    },
  },
  {
    name: "fclt_runtime",
    description:
      "Discover, bootstrap, update, or roll back the verified fclt runtime used by this plugin.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["status", "check", "policy", "stage", "apply", "rollback"],
        },
        version: { type: "string" },
        expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expectedActiveVersion: { type: "string" },
        pinnedVersion: { type: "string" },
        clearPin: { type: "boolean" },
        updateChecksEnabled: { type: "boolean" },
        approve: { type: "boolean" },
      },
    },
  },
  {
    name: "fclt_capability",
    description:
      "Inspect fclt capability, provenance, templates, snippets, adapters, and managed status without exposing secrets.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "scan",
            "inventory",
            "list",
            "show",
            "find",
            "graph",
            "adapters",
            "managed_status",
            "templates_list",
            "snippet_list",
            "snippet_show",
          ],
        },
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
        kind: {
          type: "string",
          enum: [
            "skills",
            "mcp",
            "agents",
            "automations",
            "snippets",
            "instructions",
          ],
        },
        query: { type: "string" },
        selector: { type: "string" },
        graphMode: { type: "string", enum: ["show", "deps", "dependents"] },
      },
      required: ["action"],
    },
  },
  {
    name: "fclt_workflow",
    description:
      "Run typed writeback and evolution review operations. Canonical apply and cross-scope promotion are deliberately withheld.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "writeback_list",
            "writeback_show",
            "writeback_group",
            "writeback_summarize",
            "writeback_add",
            "writeback_link",
            "writeback_disposition",
            "evolve_assess",
            "evolve_list",
            "evolve_show",
            "evolve_propose",
            "evolve_draft",
            "evolve_review",
            "evolve_verify",
          ],
        },
        scope: { type: "string", enum: ["global", "project"] },
        cwd: { type: "string" },
        id: { type: "string" },
        kind: { type: "string" },
        category: {
          type: "string",
          enum: ["friction", "opportunity", "reusable-success"],
        },
        summary: { type: "string" },
        details: { type: "string", maxLength: 2000 },
        impact: { type: "string", maxLength: 1000 },
        attemptedWorkaround: { type: "string", maxLength: 1000 },
        desiredOutcome: { type: "string", maxLength: 1000 },
        sensitivity: {
          type: "string",
          enum: ["public", "internal", "private"],
        },
        asset: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        by: { type: "string", enum: ["asset", "kind", "domain"] },
        issue: { type: "string" },
        disposition: {
          type: "string",
          enum: ["propose", "apply-local", "task", "resolve-watch", "defer"],
        },
        target: { type: "string" },
        nextTrigger: { type: "string" },
        expectedOutcome: { type: "string" },
        append: { type: "string" },
        reason: { type: "string" },
        byProposal: { type: "string" },
        effectiveness: {
          type: "string",
          enum: ["improved", "unchanged", "regressed", "inconclusive"],
        },
        note: { type: "string" },
        approve: { type: "boolean" },
      },
      required: ["action"],
    },
  },
  {
    name: "fclt_sync",
    description:
      "Inspect managed state or preview a scoped tool sync. Apply and live adoption remain withheld pending transaction-safe APIs.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "preview"] },
        scope: { type: "string", enum: ["global", "project"] },
        cwd: { type: "string" },
        tool: { type: "string" },
      },
      required: ["action", "scope"],
    },
  },
  {
    name: "fclt_registry",
    description:
      "Search and verify remote capability, run typed source reconciliation reviews, resolve one opaque activity action locator, or record one revision-bound signal decision. Canonical and external mutation remains withheld.",
    inputSchema: {
      oneOf: [
        {
          type: "object",
          properties: {
            action: { const: "activity_decide" },
            locator: {
              type: "string",
              pattern: "^fclt-act-v[0-9]+\\.[a-f0-9]{64}\\.[a-f0-9]{64}$",
            },
            decision: {
              type: "string",
              enum: ["accept", "redirect", "reject", "defer"],
            },
            expectedRevision: { type: "integer", minimum: 1 },
            actor: {
              type: "string",
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$",
            },
            approvalReference: { type: "string", minLength: 1, maxLength: 500 },
            note: { type: "string", minLength: 1, maxLength: 1000 },
            redirectTarget: { type: "string", minLength: 1, maxLength: 500 },
            approve: { const: true },
          },
          required: [
            "action",
            "locator",
            "decision",
            "expectedRevision",
            "actor",
            "approve",
          ],
          allOf: [
            {
              oneOf: [
                {
                  required: ["approvalReference"],
                  not: { required: ["note"] },
                },
                {
                  required: ["note"],
                  not: { required: ["approvalReference"] },
                },
              ],
            },
          ],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            action: { const: "activity_resolve" },
            locator: {
              type: "string",
              pattern: "^fclt-act-v[0-9]+\\.[a-f0-9]{64}\\.[a-f0-9]{64}$",
            },
          },
          required: ["action", "locator"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "search",
                "verify_source",
                "source_list",
                "install_preview",
                "update_check",
                "reconcile_status",
                "reconcile",
              ],
            },
            scope: { type: "string", enum: ["global", "project"] },
            cwd: { type: "string" },
            query: { type: "string" },
            source: { type: "string" },
            item: { type: "string" },
            as: { type: "string" },
            since: {
              type: "string",
              pattern:
                "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2}))?$",
            },
            until: {
              type: "string",
              pattern:
                "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2}))?$",
            },
            sourceIds: {
              type: "array",
              items: {
                type: "string",
                pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
              },
            },
            incremental: { type: "boolean" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      ],
    },
  },
  {
    name: "fclt_audit",
    description:
      "Run a structured, redacted, non-interactive fclt security audit with no report or index writes.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["scan"] },
        cwd: { type: "string" },
        target: { type: "string" },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
        },
      },
      required: ["action"],
    },
  },
  {
    name: "fclt_automation",
    description:
      "Read one aggregate activity set across all configured loops by default, or inspect one explicit loop scope. Schedule and canonical mutation remain CLI-only.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "autosync_status",
            "loop_status",
            "loop_activity",
            "loop_preview",
          ],
        },
        scope: {
          type: "string",
          enum: ["all", "global", "project"],
        },
        cwd: { type: "string" },
        tool: { type: "string" },
      },
      required: ["action"],
      oneOf: [
        {
          properties: {
            action: { const: "loop_activity" },
            scope: {
              type: "string",
              enum: ["all", "global", "project"],
              default: "all",
            },
          },
          required: ["action"],
        },
        {
          properties: {
            action: {
              enum: ["autosync_status", "loop_status", "loop_preview"],
            },
            scope: { type: "string", enum: ["global", "project"] },
          },
          required: ["action", "scope"],
        },
      ],
    },
  },
  {
    name: "fclt_status",
    description:
      "Return fclt status for the current, global, or project scope.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "fclt_doctor",
    description: "Run read-only fclt doctor checks and return JSON output.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "fclt_paths",
    description: "Return canonical, generated, review, and runtime fclt paths.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "fclt_init_operating_model",
    description: "Install or update the built-in operating-model pack.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"] },
        cwd: { type: "string" },
        update: { type: "boolean" },
        dryRun: { type: "boolean" },
        force: { type: "boolean" },
        approve: { type: "boolean" },
      },
      required: ["scope"],
    },
  },
  {
    name: "fclt_writeback_add",
    description: "Record a durable fclt writeback with evidence.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"] },
        cwd: { type: "string" },
        kind: { type: "string" },
        category: {
          type: "string",
          enum: ["friction", "opportunity", "reusable-success"],
        },
        summary: { type: "string" },
        details: { type: "string", maxLength: 2000 },
        impact: { type: "string", maxLength: 1000 },
        attemptedWorkaround: { type: "string", maxLength: 1000 },
        desiredOutcome: { type: "string", maxLength: 1000 },
        sensitivity: {
          type: "string",
          enum: ["public", "internal", "private"],
        },
        asset: { type: "string" },
        evidence: { type: "string" },
        confidence: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
        approve: { type: "boolean" },
      },
      required: ["scope", "kind", "summary", "evidence", "approve"],
    },
  },
  {
    name: "fclt_writeback_review",
    description: "List, group, or summarize current fclt writebacks.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"] },
        cwd: { type: "string" },
        mode: { type: "string", enum: ["list", "group", "summarize"] },
        by: { type: "string" },
      },
    },
  },
  {
    name: "fclt_evolve",
    description:
      "Assess, list, propose, draft, or review fclt evolution proposals.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
        action: {
          type: "string",
          enum: ["assess", "list", "propose", "draft", "review", "show"],
        },
        id: { type: "string" },
        asset: { type: "string" },
        approve: { type: "boolean" },
      },
    },
  },
];

for (const tool of tools) {
  if (!tool.inputSchema.oneOf || tool.inputSchema.properties) {
    tool.inputSchema.additionalProperties = false;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateToolArguments(name, args) {
  if (!isPlainObject(args)) {
    throw new Error(`${name} arguments must be an object`);
  }
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const rootSchema = tool.inputSchema;
  const schema =
    rootSchema.oneOf && !rootSchema.properties
      ? rootSchema.oneOf.find((branch) => {
          const action = branch.properties?.action;
          return (
            action?.const === args.action || action?.enum?.includes(args.action)
          );
        })
      : rootSchema;
  if (!schema) {
    throw new Error(`${name}.action is not an allowed value`);
  }
  const properties = schema.properties || {};
  const unknown = Object.keys(args).filter((key) => !(key in properties));
  if (unknown.length > 0) {
    throw new Error(
      `${name} received unknown argument fields: ${unknown.join(", ")}`
    );
  }
  for (const required of schema.required || []) {
    if (!(required in args)) {
      throw new Error(`${name} requires ${required}`);
    }
  }
  for (const constraint of schema.allOf || []) {
    if (Array.isArray(constraint.oneOf)) {
      const matches = constraint.oneOf.filter((branch) => {
        const hasRequired = (branch.required || []).every((key) => key in args);
        const violatesNot = branch.not?.required
          ? branch.not.required.every((key) => key in args)
          : false;
        return hasRequired && !violatesNot;
      });
      if (matches.length !== 1) {
        throw new Error(
          `${name} arguments do not match exactly one allowed shape`
        );
      }
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (property.const !== undefined && value !== property.const) {
      throw new Error(`${name}.${key} is not an allowed value`);
    }
    if (!property.type) {
      continue;
    }
    const validType =
      property.type === "array"
        ? Array.isArray(value)
        : property.type === "object"
          ? isPlainObject(value)
          : property.type === "integer"
            ? Number.isSafeInteger(value)
            : typeof value === property.type;
    if (!validType) {
      throw new Error(`${name}.${key} must be ${property.type}`);
    }
    if (property.enum && !property.enum.includes(value)) {
      throw new Error(`${name}.${key} is not an allowed value`);
    }
    if (
      typeof value === "string" &&
      ((property.minLength !== undefined &&
        value.length < property.minLength) ||
        (property.maxLength !== undefined && value.length > property.maxLength))
    ) {
      throw new Error(`${name}.${key} has an invalid length`);
    }
    if (
      typeof value === "number" &&
      property.minimum !== undefined &&
      value < property.minimum
    ) {
      throw new Error(`${name}.${key} is below the minimum`);
    }
    if (property.pattern && !new RegExp(property.pattern).test(value)) {
      throw new Error(`${name}.${key} has an invalid format`);
    }
    if (
      property.type === "array" &&
      property.items?.type &&
      value.some((item) => typeof item !== property.items.type)
    ) {
      throw new Error(`${name}.${key} contains an invalid item`);
    }
    if (
      property.type === "array" &&
      property.items?.pattern &&
      value.some((item) => !new RegExp(property.items.pattern).test(item))
    ) {
      throw new Error(`${name}.${key} contains an invalid item`);
    }
  }
}

function scopeArgs(scope) {
  if (scope === "global") {
    return ["--global"];
  }
  if (scope === "project") {
    return ["--project"];
  }
  return [];
}

function boolFlag(name, value) {
  return value ? [name] : [];
}

function stringFlag(name, value) {
  return typeof value === "string" && value.trim() ? [name, value] : [];
}

function repeatedStringFlag(name, values) {
  return Array.isArray(values)
    ? values.flatMap((value) => stringFlag(name, value))
    : [];
}

function requireString(name, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireMutationApproval(name, args) {
  if (args.scope !== "global" && args.scope !== "project") {
    throw new Error(`${name} requires an explicit global or project scope`);
  }
  if (args.approve !== true) {
    throw new Error(`${name} requires approve=true`);
  }
}

function capabilityCommand(args) {
  const action = args.action;
  if (action === "scan") {
    return ["scan", "--json"];
  }
  if (action === "inventory") {
    return ["inventory", ...scopeArgs(args.scope), "--json"];
  }
  if (action === "list") {
    return ["list", args.kind || "skills", ...scopeArgs(args.scope), "--json"];
  }
  if (action === "show") {
    return [
      "show",
      requireString("selector", args.selector),
      ...scopeArgs(args.scope),
    ];
  }
  if (action === "find") {
    return [
      "find",
      requireString("query", args.query),
      ...scopeArgs(args.scope),
      "--json",
    ];
  }
  if (action === "graph") {
    return [
      "graph",
      args.graphMode || "show",
      requireString("selector", args.selector),
      ...scopeArgs(args.scope),
      "--json",
    ];
  }
  if (action === "adapters") {
    return ["adapters", "--json"];
  }
  if (action === "managed_status") {
    return ["managed", ...scopeArgs(args.scope)];
  }
  if (action === "templates_list") {
    return ["templates", "list", "--json"];
  }
  if (action === "snippet_list") {
    return ["snippets", "list", "--json"];
  }
  if (action === "snippet_show") {
    return [
      "snippets",
      "show",
      requireString("selector", args.selector),
      "--json",
    ];
  }
  throw new Error(`Unsupported capability action: ${action}`);
}

const WORKFLOW_MUTATIONS = new Set([
  "writeback_add",
  "writeback_link",
  "writeback_disposition",
  "writeback_dismiss",
  "writeback_promote",
  "evolve_propose",
  "evolve_draft",
  "evolve_review",
  "evolve_accept",
  "evolve_reject",
  "evolve_supersede",
  "evolve_verify",
]);

const WORKFLOW_ACTION_FIELDS = {
  writeback_list: [],
  writeback_show: ["id"],
  writeback_group: ["by"],
  writeback_summarize: ["by"],
  writeback_add: [
    "kind",
    "category",
    "summary",
    "details",
    "impact",
    "attemptedWorkaround",
    "desiredOutcome",
    "sensitivity",
    "asset",
    "evidence",
    "confidence",
    "approve",
  ],
  writeback_link: ["id", "issue", "approve"],
  writeback_disposition: [
    "id",
    "disposition",
    "target",
    "nextTrigger",
    "expectedOutcome",
    "approve",
  ],
  evolve_assess: ["asset"],
  evolve_list: [],
  evolve_show: ["id"],
  evolve_propose: ["asset", "approve"],
  evolve_draft: ["id", "append", "approve"],
  evolve_review: ["id", "approve"],
  evolve_verify: ["id", "effectiveness", "evidence", "note", "approve"],
};

function requireOnlyWorkflowFields(args) {
  const fields = WORKFLOW_ACTION_FIELDS[args.action];
  if (!fields) {
    return;
  }
  const allowed = new Set(["action", "scope", "cwd", ...fields]);
  const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${args.action} received unsupported fields: ${unexpected.join(", ")}`
    );
  }
}

function workflowCommand(args) {
  const action = args.action;
  requireOnlyWorkflowFields(args);
  if (WORKFLOW_MUTATIONS.has(action)) {
    requireMutationApproval(action, args);
  }
  const scope = scopeArgs(args.scope);
  if (action === "writeback_list") {
    return ["ai", "writeback", ...scope, "list", "--json"];
  }
  if (action === "writeback_show") {
    return [
      "ai",
      "writeback",
      ...scope,
      "show",
      requireString("id", args.id),
      "--json",
    ];
  }
  if (action === "writeback_group" || action === "writeback_summarize") {
    return [
      "ai",
      "writeback",
      ...scope,
      action === "writeback_group" ? "group" : "summarize",
      ...stringFlag("--by", args.by),
      "--json",
    ];
  }
  if (action === "writeback_add") {
    if (!Array.isArray(args.evidence) || args.evidence.length === 0) {
      throw new Error("writeback_add requires at least one evidence reference");
    }
    return [
      "ai",
      "writeback",
      ...scope,
      "add",
      "--kind",
      requireString("kind", args.kind),
      "--summary",
      requireString("summary", args.summary),
      ...stringFlag("--asset", args.asset),
      ...stringFlag("--category", args.category),
      ...stringFlag("--details", args.details),
      ...stringFlag("--impact", args.impact),
      ...stringFlag("--attempted-workaround", args.attemptedWorkaround),
      ...stringFlag("--desired-outcome", args.desiredOutcome),
      ...stringFlag("--sensitivity", args.sensitivity),
      ...repeatedStringFlag("--evidence", args.evidence),
      ...stringFlag("--confidence", args.confidence),
      "--json",
    ];
  }
  if (action === "writeback_link") {
    return [
      "ai",
      "writeback",
      ...scope,
      "link",
      requireString("id", args.id),
      "--issue",
      requireString("issue", args.issue),
    ];
  }
  if (action === "writeback_disposition") {
    return [
      "ai",
      "writeback",
      ...scope,
      "disposition",
      requireString("id", args.id),
      "--type",
      requireString("disposition", args.disposition),
      ...stringFlag("--target", args.target),
      ...stringFlag("--next-trigger", args.nextTrigger),
      ...stringFlag("--expected-outcome", args.expectedOutcome),
    ];
  }
  if (action === "writeback_dismiss" || action === "writeback_promote") {
    return [
      "ai",
      "writeback",
      ...scope,
      action === "writeback_dismiss" ? "dismiss" : "promote",
      requireString("id", args.id),
    ];
  }
  if (action === "evolve_assess") {
    return [
      "ai",
      "evolve",
      ...scope,
      "assess",
      ...stringFlag("--asset", args.asset),
      "--json",
    ];
  }
  if (action === "evolve_list") {
    return ["ai", "evolve", ...scope, "list", "--json"];
  }
  if (action === "evolve_show") {
    return [
      "ai",
      "evolve",
      ...scope,
      "show",
      requireString("id", args.id),
      "--json",
    ];
  }
  if (action === "evolve_propose") {
    return [
      "ai",
      "evolve",
      ...scope,
      "propose",
      "--asset",
      requireString("asset", args.asset),
      "--json",
    ];
  }
  if (action === "evolve_draft") {
    return [
      "ai",
      "evolve",
      ...scope,
      "draft",
      requireString("id", args.id),
      ...stringFlag("--append", args.append),
    ];
  }
  if (action === "evolve_review" || action === "evolve_accept") {
    return [
      "ai",
      "evolve",
      ...scope,
      action === "evolve_review" ? "review" : "accept",
      requireString("id", args.id),
    ];
  }
  if (action === "evolve_reject") {
    return [
      "ai",
      "evolve",
      ...scope,
      "reject",
      requireString("id", args.id),
      "--reason",
      requireString("reason", args.reason),
    ];
  }
  if (action === "evolve_supersede") {
    return [
      "ai",
      "evolve",
      ...scope,
      "supersede",
      requireString("id", args.id),
      "--by",
      requireString("byProposal", args.byProposal),
    ];
  }
  if (action === "evolve_verify") {
    if (!Array.isArray(args.evidence) || args.evidence.length === 0) {
      throw new Error("evolve_verify requires at least one evidence reference");
    }
    return [
      "ai",
      "evolve",
      ...scope,
      "verify",
      requireString("id", args.id),
      "--effectiveness",
      requireString("effectiveness", args.effectiveness),
      ...repeatedStringFlag("--evidence", args.evidence),
      ...stringFlag("--note", args.note),
    ];
  }
  throw new Error(`Unsupported workflow action: ${action}`);
}

function syncCommand(args) {
  if (args.action === "status") {
    return ["managed", ...scopeArgs(args.scope)];
  }
  if (args.action === "preview") {
    return [
      "sync",
      ...(args.tool ? [args.tool] : []),
      "--dry-run",
      ...scopeArgs(args.scope),
    ];
  }
  throw new Error(`Unsupported sync action: ${args.action}`);
}

function requireOnlyRegistryFields(args, fields) {
  const allowed = new Set(["action", "scope", "cwd", ...fields]);
  const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${args.action} received unsupported fields: ${unexpected.join(", ")}`
    );
  }
}

function registryCommand(args) {
  if (args.action === "activity_decide") {
    const expectedFields = new Set([
      "action",
      "locator",
      "decision",
      "expectedRevision",
      "actor",
      "approvalReference",
      "note",
      "redirectTarget",
      "approve",
    ]);
    const unexpected = Object.keys(args).filter(
      (key) => !expectedFields.has(key)
    );
    if (unexpected.length > 0) {
      throw new Error(
        `activity_decide received unsupported fields: ${unexpected.join(", ")}`
      );
    }
    if (args.approve !== true) {
      throw new Error("activity_decide requires approve=true");
    }
    if (!Number.isSafeInteger(args.expectedRevision)) {
      throw new Error(
        "activity_decide requires expectedRevision as an integer"
      );
    }
    return [
      "ai",
      "loop",
      "decide",
      requireString("locator", args.locator),
      "--decision",
      requireString("decision", args.decision),
      "--expected-revision",
      String(args.expectedRevision),
      "--actor",
      requireString("actor", args.actor),
      ...stringFlag("--approval-ref", args.approvalReference),
      ...stringFlag("--note", args.note),
      ...stringFlag("--redirect-target", args.redirectTarget),
      "--approve",
      "--json",
    ];
  }
  if (args.action === "activity_resolve") {
    const unexpected = Object.keys(args).filter(
      (key) => key !== "action" && key !== "locator"
    );
    if (unexpected.length > 0) {
      throw new Error(
        `activity_resolve received unsupported fields: ${unexpected.join(", ")}`
      );
    }
    return [
      "ai",
      "loop",
      "resolve",
      requireString("locator", args.locator),
      "--json",
    ];
  }
  if (
    args.scope === "project" &&
    args.action !== "reconcile_status" &&
    args.action !== "reconcile"
  ) {
    throw new Error(`${args.action} only supports global scope`);
  }
  if (args.action === "search") {
    requireOnlyRegistryFields(args, ["query"]);
    return ["search", requireString("query", args.query), "--json"];
  }
  if (args.action === "verify_source") {
    requireOnlyRegistryFields(args, ["source"]);
    return ["verify-source", requireString("source", args.source), "--json"];
  }
  if (args.action === "source_list") {
    requireOnlyRegistryFields(args, []);
    return ["sources", "list", "--json"];
  }
  if (args.action === "install_preview") {
    requireOnlyRegistryFields(args, ["item", "as"]);
    return [
      "install",
      requireString("item", args.item),
      ...stringFlag("--as", args.as),
      "--dry-run",
      "--strict-source-trust",
      "--json",
    ];
  }
  if (args.action === "update_check") {
    requireOnlyRegistryFields(args, []);
    return ["update", "--strict-source-trust", "--json"];
  }
  if (args.action === "reconcile_status") {
    requireOnlyRegistryFields(args, []);
    if (args.scope !== "global" && args.scope !== "project") {
      throw new Error(
        "reconcile_status requires an explicit global or project scope"
      );
    }
    return ["ai", "review", ...scopeArgs(args.scope), "status", "--json"];
  }
  if (args.action === "reconcile") {
    requireOnlyRegistryFields(args, [
      "since",
      "until",
      "sourceIds",
      "incremental",
    ]);
    if (args.scope !== "global" && args.scope !== "project") {
      throw new Error("reconcile requires an explicit global or project scope");
    }
    return [
      "ai",
      "review",
      ...scopeArgs(args.scope),
      "reconcile",
      "--since",
      requireString("since", args.since),
      ...stringFlag("--until", args.until),
      ...repeatedStringFlag("--source", args.sourceIds),
      ...boolFlag("--incremental", args.incremental),
      "--json",
    ];
  }
  throw new Error(`Unsupported registry action: ${args.action}`);
}

function isSubpath(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolveWorkspaceCwd({ allowHomeFallback = true } = {}) {
  const candidates = [
    process.env.FCLT_MCP_WORKSPACE_CWD,
    process.env.INIT_CWD,
    process.env.PWD,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }
    const resolved = path.resolve(candidate);
    const isHome = resolved === path.resolve(os.homedir());
    if (
      (allowHomeFallback || !isHome) &&
      !isSubpath(resolved, PLUGIN_ROOT) &&
      isDirectory(resolved)
    ) {
      return resolved;
    }
  }
  if (allowHomeFallback && isDirectory(os.homedir())) {
    return os.homedir();
  }
  return undefined;
}

function resolveToolCwd(name, args = {}) {
  if (typeof args.cwd === "string" && args.cwd.trim()) {
    return args.cwd;
  }
  const inferred = resolveWorkspaceCwd({
    allowHomeFallback: args.scope !== "project",
  });
  if (inferred) {
    return inferred;
  }
  if (args.scope === "project") {
    throw new Error(
      `${name} with project scope requires a cwd for the target workspace`
    );
  }
  return process.cwd();
}

function commandForTool(name, args = {}) {
  switch (name) {
    case "fclt_setup": {
      const apply = args.dryRun === false;
      if (apply && args.approve !== true) {
        throw new Error("fclt_setup apply requires approve=true");
      }
      if (
        args.scope === "global_and_project" &&
        (typeof args.cwd !== "string" || !args.cwd.trim())
      ) {
        throw new Error(
          "fclt_setup global_and_project scope requires an explicit cwd"
        );
      }
      return [
        "setup",
        "--json",
        ...(args.scope === "global_and_project" ? ["--include-project"] : []),
        ...(apply ? [] : ["--dry-run"]),
        ...(args.installCodexPlugin === false ? ["--no-codex-plugin"] : []),
      ];
    }
    case "fclt_capability":
      return capabilityCommand(args);
    case "fclt_workflow":
      return workflowCommand(args);
    case "fclt_sync":
      return syncCommand(args);
    case "fclt_registry":
      return registryCommand(args);
    case "fclt_audit":
      return [
        "audit",
        "--non-interactive",
        ...(args.target ? [args.target] : []),
        ...stringFlag("--severity", args.severity),
        "--json",
      ];
    case "fclt_automation":
      if (
        args.action !== "loop_activity" &&
        args.scope !== "global" &&
        args.scope !== "project"
      ) {
        throw new Error(`${args.action} requires global or project scope`);
      }
      if (args.action === "autosync_status") {
        return [
          "autosync",
          "status",
          ...(args.tool ? [args.tool] : []),
          ...scopeArgs(args.scope),
        ];
      }
      if (args.tool) {
        throw new Error(`${args.action} does not accept tool`);
      }
      if (args.action === "loop_status") {
        return ["ai", "loop", ...scopeArgs(args.scope), "status", "--json"];
      }
      if (args.action === "loop_activity") {
        return [
          "ai",
          "loop",
          ...scopeArgs(args.scope),
          "activity",
          ...(args.scope === "global" || args.scope === "project"
            ? []
            : ["--all"]),
          "--json",
        ];
      }
      if (args.action === "loop_preview") {
        return [
          "ai",
          "loop",
          ...scopeArgs(args.scope),
          "run",
          "--dry-run",
          "--json",
        ];
      }
      throw new Error(`Unsupported automation action: ${args.action}`);
    case "fclt_status":
      return ["status", ...scopeArgs(args.scope), "--json"];
    case "fclt_doctor":
      return ["doctor", ...scopeArgs(args.scope), "--json"];
    case "fclt_paths":
      return ["paths", ...scopeArgs(args.scope), "--json"];
    case "fclt_init_operating_model":
      if (args.dryRun === false && args.approve !== true) {
        throw new Error(
          "fclt_init_operating_model apply requires approve=true"
        );
      }
      if (args.force === true && args.approve !== true) {
        throw new Error(
          "fclt_init_operating_model force requires approve=true"
        );
      }
      return [
        "templates",
        "init",
        "operating-model",
        ...scopeArgs(args.scope),
        ...boolFlag("--update", args.update),
        ...(args.dryRun === false ? [] : ["--dry-run"]),
        ...boolFlag("--force", args.force),
        "--json",
      ];
    case "fclt_writeback_add":
      requireMutationApproval(name, args);
      requireString("evidence", args.evidence);
      return [
        "ai",
        "writeback",
        ...scopeArgs(args.scope),
        "add",
        "--kind",
        args.kind,
        "--summary",
        args.summary,
        ...stringFlag("--asset", args.asset),
        ...stringFlag("--category", args.category),
        ...stringFlag("--details", args.details),
        ...stringFlag("--impact", args.impact),
        ...stringFlag("--attempted-workaround", args.attemptedWorkaround),
        ...stringFlag("--desired-outcome", args.desiredOutcome),
        ...stringFlag("--sensitivity", args.sensitivity),
        ...stringFlag("--evidence", args.evidence),
        ...stringFlag("--confidence", args.confidence),
        "--json",
      ];
    case "fclt_writeback_review": {
      const mode = args.mode || "list";
      return [
        "ai",
        "writeback",
        ...scopeArgs(args.scope),
        mode,
        ...stringFlag("--by", args.by),
      ];
    }
    case "fclt_evolve": {
      const action = args.action || "list";
      if (["propose", "draft", "review"].includes(action)) {
        requireMutationApproval(`fclt_evolve ${action}`, args);
      }
      if (action === "propose") {
        requireString("asset", args.asset);
      }
      if (["draft", "review", "show"].includes(action)) {
        requireString("id", args.id);
      }
      return [
        "ai",
        "evolve",
        ...scopeArgs(args.scope),
        action,
        ...(action === "assess" || action === "propose"
          ? stringFlag("--asset", args.asset)
          : []),
        ...(args.id ? [args.id] : []),
        ...(action === "assess" ? ["--json"] : []),
      ];
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function operationMetadata(name, args, command) {
  const action =
    name === "fclt_writeback_add"
      ? "writeback_add"
      : name === "fclt_evolve"
        ? `evolve_${args.action || "list"}`
        : args.action || name;
  const reviewActions = new Set([
    "activity_decide",
    "writeback_add",
    "writeback_link",
    "writeback_disposition",
    "evolve_propose",
    "evolve_draft",
    "evolve_review",
    "evolve_verify",
    "reconcile",
  ]);
  const preview = command.includes("--dry-run");
  const risk = reviewActions.has(action)
    ? "review_producing"
    : !preview && name === "fclt_setup"
      ? "reversible_mutation"
      : !preview && name === "fclt_init_operating_model"
        ? "high_risk_destructive"
        : "read_only";
  return {
    tool: name,
    action,
    risk,
    scope:
      args.scope ||
      (name === "fclt_automation" && action === "loop_activity"
        ? "all"
        : "auto"),
    target:
      args.id ||
      args.selector ||
      args.asset ||
      args.item ||
      args.source ||
      args.tool ||
      args.locator ||
      null,
    preview,
  };
}

function recoveryForOperation(operation, stdout) {
  if (operation.risk === "review_producing") {
    return {
      canonicalCapabilityChanged: false,
      audit: "native fclt review artifacts and append-only journal",
    };
  }
  if (
    operation.risk !== "reversible_mutation" &&
    operation.risk !== "high_risk_destructive"
  ) {
    return null;
  }
  const report = isPlainObject(stdout) ? stdout : {};
  return {
    rollbackAvailable: false,
    changedPaths: Array.isArray(report.changedPaths) ? report.changedPaths : [],
    skippedPaths: Array.isArray(report.skippedPaths) ? report.skippedPaths : [],
    repairActions: Array.isArray(report.repairActions)
      ? report.repairActions
      : [],
    verification:
      operation.tool === "fclt_setup"
        ? "rerun fclt_setup in preview mode and verify doctor readiness"
        : "verify doctor, generated state, authored-file hashes, and exact target paths",
  };
}

async function runFclt(args, cwd, operation) {
  const discovery = await runtime.discoverRuntime();
  if (!discovery.selected) {
    return {
      code: 1,
      text: JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          error: "no_compatible_runtime",
          message:
            "No compatible fclt runtime is available. Check, stage, and apply an explicit verified version with fclt_runtime.",
          runtime: discovery,
        },
        null,
        2
      ),
    };
  }

  if (
    operation.tool === "fclt_audit" &&
    !discovery.selected.capabilities?.includes(AUDIT_READ_ONLY_CAPABILITY)
  ) {
    return {
      code: 1,
      text: JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          error: "missing_runtime_capability",
          message:
            "The selected fclt runtime does not advertise audit-read-only-v1; typed audit fails closed.",
          runtime: discovery,
        },
        null,
        2
      ),
    };
  }

  if (
    operation.action === "activity_decide" &&
    !discovery.selected.capabilities?.includes(
      ACTIVITY_ACTION_DECIDE_CAPABILITY
    )
  ) {
    return {
      code: 1,
      text: JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          error: "missing_runtime_capability",
          message:
            "The selected fclt runtime does not advertise activity-action-decide-v1; typed activity decisions fail closed.",
          runtime: discovery,
        },
        null,
        2
      ),
    };
  }

  if (
    operation.action === "activity_resolve" &&
    !discovery.selected.capabilities?.includes(
      ACTIVITY_ACTION_RESOLVE_CAPABILITY
    )
  ) {
    return {
      code: 1,
      text: JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          error: "missing_runtime_capability",
          message:
            "The selected fclt runtime does not advertise activity-action-resolve-v1; typed activity resolution fails closed.",
          runtime: discovery,
        },
        null,
        2
      ),
    };
  }

  const result = await runtime.runCommand(discovery.selected.executable, args, {
    cwd: cwd || process.cwd(),
    env: process.env,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  const parsedStdout = parseJsonOrText(result.stdout.trim());
  return {
    code: result.code,
    text: JSON.stringify(
      {
        schemaVersion: 1,
        operation,
        runtime: discovery.selected,
        result: {
          exitCode: result.code,
          stdout: parsedStdout,
          stderr: result.stderr,
        },
        verification: {
          status: result.code === 0 ? "passed" : "failed",
          exitCode: result.code,
        },
        recovery: recoveryForOperation(operation, parsedStdout),
      },
      null,
      2
    ),
  };
}

function parseJsonOrText(value) {
  if (!value) {
    return "";
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function handleRuntimeTool(args = {}) {
  const action = args.action || "status";
  if (action === "status") {
    return await runtime.discoverRuntime();
  }
  if (action === "check") {
    return await runtime.checkRuntimeUpdate();
  }
  if (action === "policy") {
    return await runtime.setRuntimePolicy({
      approve: args.approve,
      pinnedVersion: args.pinnedVersion,
      clearPin: args.clearPin,
      updateChecksEnabled: args.updateChecksEnabled,
    });
  }
  if (action === "stage") {
    return await runtime.stageRuntime({
      approve: args.approve,
      version: args.version,
    });
  }
  if (action === "apply") {
    return await runtime.applyStagedRuntime({
      approve: args.approve,
      expectedSha256: args.expectedSha256,
      version: args.version,
    });
  }
  if (action === "rollback") {
    return await runtime.rollbackRuntime({
      approve: args.approve,
      expectedActiveVersion: args.expectedActiveVersion,
    });
  }
  throw new Error(`Unknown runtime action: ${action}`);
}

function runtimeOperationMetadata(args, result) {
  const action = args.action || "status";
  const risk =
    action === "status" || action === "check"
      ? "read_only"
      : action === "stage"
        ? "review_producing"
        : "high_risk_destructive";
  return {
    operation: {
      tool: "fclt_runtime",
      action,
      risk,
      scope: "plugin_runtime",
      target:
        args.version ||
        args.pinnedVersion ||
        args.expectedActiveVersion ||
        null,
      approved: args.approve === true,
    },
    verification: {
      status: "passed",
      activeVersion:
        result.active?.packageVersion ||
        result.selected?.packageVersion ||
        null,
    },
    recovery:
      action === "apply" || action === "rollback"
        ? {
            rollbackAvailable: result.rollbackAvailable === true,
            previous: result.previous || null,
          }
        : action === "policy"
          ? { previousPolicy: result.previous || null }
          : null,
  };
}

let transportFraming = "content-length";

function send(message) {
  const body = JSON.stringify(message);
  if (transportFraming === "newline") {
    process.stdout.write(`${body}\n`);
    return;
  }
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

async function handle(message) {
  if (!message || message.id == null) {
    return;
  }

  try {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fclt", version: runtime.pluginVersion() },
        },
      });
      return;
    }
    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools } });
      return;
    }
    if (message.method === "tools/call") {
      const { name, arguments: args = {} } = message.params || {};
      validateToolArguments(name, args);
      if (name === "fclt_runtime") {
        const result = await handleRuntimeTool(args);
        const metadata = runtimeOperationMetadata(args, result);
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...result, ...metadata }, null, 2),
              },
            ],
          },
        });
        return;
      }
      const command = commandForTool(name, args);
      const result = await runFclt(
        command,
        resolveToolCwd(name, args),
        operationMetadata(name, args, command)
      );
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: result.code !== 0,
          content: [{ type: "text", text: result.text }],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32_601, message: `Method not found: ${message.method}` },
    });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32_000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

let buffer = Buffer.alloc(0);

function dispatch(body, framing) {
  transportFraming = framing;
  handle(JSON.parse(body)).catch((error) => {
    send({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32_000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  });
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    while (buffer[0] === 10 || buffer[0] === 13) {
      buffer = buffer.subarray(1);
    }
    if (buffer.length === 0) {
      return;
    }
    if (buffer[0] === 123 || buffer[0] === 91) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      const body = buffer.subarray(0, lineEnd).toString("utf8").trim();
      buffer = buffer.subarray(lineEnd + 1);
      if (body) {
        dispatch(body, "newline");
      }
      continue;
    }
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = CONTENT_LENGTH_RE.exec(header);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const frameEnd = headerEnd + 4 + length;
    if (buffer.length < frameEnd) {
      return;
    }
    const body = buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
    buffer = buffer.slice(frameEnd);
    dispatch(body, "content-length");
  }
});

if (process.argv.includes("--self-test")) {
  console.log(
    JSON.stringify(
      {
        pluginVersion: runtime.pluginVersion(),
        protocolVersion: runtime.PLUGIN_PROTOCOL_VERSION,
        tools: tools.map((tool) => tool.name),
      },
      null,
      2
    )
  );
  process.exit(0);
}
