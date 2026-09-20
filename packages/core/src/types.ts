import { z } from "zod";

export type Severity = "blocker" | "warning" | "nit";

/**
 * Models don't reliably stick to our three severities — they emit "major",
 * "critical", "minor", "info", etc. Map common synonyms onto our scale rather
 * than rejecting the whole review; unknown values default to warning.
 */
const SEVERITY_ALIASES: Record<string, Severity> = {
  blocker: "blocker",
  critical: "blocker",
  high: "blocker",
  error: "blocker",
  warning: "warning",
  major: "warning",
  medium: "warning",
  moderate: "warning",
  nit: "nit",
  minor: "nit",
  low: "nit",
  info: "nit",
  trivial: "nit",
  suggestion: "nit",
};

// Severity is often missing or off-scale; never let that reject a finding.
const severitySchema = z
  .string()
  .optional()
  .transform(
    (s): Severity =>
      s ? (SEVERITY_ALIASES[s.toLowerCase().trim()] ?? "warning") : "warning",
  );

/**
 * A single review finding, anchored to a line in the new version of a file.
 * `line` is the line number in the file as it exists after the PR (RIGHT side
 * of the diff) — GitHub only accepts inline comments on lines in the diff.
 */
export const findingSchema = z.object({
  path: z.string(),
  line: z.coerce.number().int().positive(),
  severity: severitySchema,
  body: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

/** A major, PR-level callout that isn't tied to a single diff line. */
export const concernSchema = z.object({
  title: z.string(),
  detail: z.string(),
  severity: severitySchema,
});
export type Concern = z.infer<typeof concernSchema>;

/**
 * The kinds of non-blocking human callouts a reviewer can surface. Adapted from
 * pi-review's "Human Reviewer Callouts (Non-Blocking)" section. A callout is
 * informational — it must never change the verdict or become a fix item on its
 * own. Unknown `kind` values are kept (defaulted to "other") rather than
 * dropping the callout, so a model that invents a reasonable kind still reaches
 * the human.
 */
export const CALLOUT_KINDS = [
  "migration",
  "new-dependency",
  "changed-dependency",
  "auth-permissions",
  "breaking-change",
  "destructive-op",
  "feature-flag",
  "config-default",
] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number] | "other";

const calloutKindSchema = z
  .string()
  .optional()
  .transform((k): CalloutKind => {
    const norm = k?.toLowerCase().trim();
    if (!norm) return "other";
    if ((CALLOUT_KINDS as readonly string[]).includes(norm)) {
      return norm as CalloutKind;
    }
    // Tolerate common synonyms a model might emit.
    const aliases: Record<string, CalloutKind> = {
      "db-migration": "migration",
      "database-migration": "migration",
      "new-dependency-added": "new-dependency",
      "dependency-change": "changed-dependency",
      "lockfile-change": "changed-dependency",
      auth: "auth-permissions",
      permissions: "auth-permissions",
      "backwards-incompatible": "breaking-change",
      incompatible: "breaking-change",
      irreversible: "destructive-op",
      destructive: "destructive-op",
      flag: "feature-flag",
      config: "config-default",
      "default-change": "config-default",
    };
    return aliases[norm] ?? "other";
  });

export const calloutSchema = z.object({
  kind: calloutKindSchema,
  body: z.string().min(1),
});
export type Callout = z.infer<typeof calloutSchema>;

/**
 * The harness's JSON. Findings, concerns, and callouts are validated
 * individually by the parser so one malformed entry can't reject the whole
 * review — keep the arrays loose here.
 */
export const reviewOutputSchema = z.object({
  summary: z.string().default(""),
  findings: z.array(z.unknown()).default([]),
  concerns: z.array(z.unknown()).default([]),
  callouts: z.array(z.unknown()).default([]),
  highlights: z.array(z.string()).default([]),
  // Optional Mermaid diagram (body only, no fences) for a genuinely complex flow.
  diagram: z.string().optional(),
});
export type ReviewOutput = {
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly concerns: readonly Concern[];
  readonly callouts: readonly Callout[];
  readonly highlights: readonly string[];
  readonly diagram?: string;
};

/** Review noise profile: which severities to keep. */
export type Profile = "quiet" | "chill" | "assertive";
const PROFILE_KEEP: Record<Profile, readonly Severity[]> = {
  quiet: ["blocker"],
  chill: ["blocker", "warning"],
  assertive: ["blocker", "warning", "nit"],
};
export function severitiesForProfile(profile: Profile): readonly Severity[] {
  return PROFILE_KEEP[profile];
}

/** One verdict from the verification pass, keyed by finding index. */
export const verdictSchema = z.object({
  index: z.coerce.number().int().nonnegative(),
  real: z.boolean(),
  reason: z.string().optional(),
});
export const verificationSchema = z.object({
  verdicts: z.array(verdictSchema).default([]),
});
