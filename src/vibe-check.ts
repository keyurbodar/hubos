import type { VibeCheckResult, VibeIssue } from "./types.ts";

const BANNED_PHRASES: RegExp[] = [
  /\bis cooking\b/i,
  /\bonly going higher\b/i,
  /\bsomething big is cooking\b/i,
  /\bis heating up\b/i,
  /\bgetting smarter\b/i,
  /\bbigger things\b/i,
  /\bundervalued\b/i,
  /\bworth watching\b/i,
  /\bunstoppable\b/i,
  /\bhits different\b/i,
  /\bbig moves\b/i,
  /\bsomething'?s brewing\b/i,
  /\bgame[- ]?changer\b/i,
  /\bredefining\b/i,
  /\brevolutionizing\b/i,
  /\bdelve\b/i,
  /\btapestry\b/i,
  /\bunleash\b/i,
  /\bunlock the power\b/i,
  /\bnext[- ]level\b/i,
  /\bin the ever[- ]evolving\b/i,
];

const EMPTY_CLOSERS: RegExp[] = [
  /^(in summary|overall|all in all|to wrap up|to sum up)\b/i,
  /^(exciting times|stay tuned|big week ahead|watch this space|keep an eye on)\b/i,
  /\bjust getting started\.?$/i,
  /\bthe future (of .+ )?is bright\.?$/i,
];

const PROGRESSIVE_BULLET = /^[-*•]\s*@?[a-zA-Z0-9_]+\s+is\s+[a-z]{3,}ing\b/i;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) {
    if (sb.has(w)) inter += 1;
  }
  return inter / (sa.size + sb.size - inter);
}

export interface VibeCheckOptions {
  body: string;
  pageName?: string;
  chainName?: string;
  sourceUrls?: string[];
  recentHooks?: string[];
}

export function runVibeCheck(opts: VibeCheckOptions): VibeCheckResult {
  const errors: VibeIssue[] = [];
  const warnings: VibeIssue[] = [];
  const lines = opts.body.split(/\r?\n/);

  // 1. Zero em dashes
  lines.forEach((line, idx) => {
    if (line.includes("\u2014")) {
      errors.push({
        rule: "no_em_dash",
        severity: "error",
        line: idx + 1,
        message: "Remove em dash character; use a comma, colon, or short sentence.",
      });
    }
  });

  // 2. Banned slop phrases
  lines.forEach((line, idx) => {
    for (const pat of BANNED_PHRASES) {
      const m = line.match(pat);
      if (m) {
        errors.push({
          rule: "banned_slop_phrase",
          severity: "error",
          line: idx + 1,
          message: `Remove hype/slop phrase "${m[0]}"; replace with a concrete fact.`,
        });
      }
    }
  });

  // 3. Repeated handle inside one bullet + >2 emoji per line
  lines.forEach((line, idx) => {
    const handles = [...line.matchAll(/@([a-zA-Z0-9_]{1,15})\b/g)].map((m) => m[1].toLowerCase());
    const seen = new Set<string>();
    for (const h of handles) {
      if (seen.has(h)) {
        errors.push({
          rule: "repeated_handle",
          severity: "error",
          line: idx + 1,
          message: `Handle @${h} is repeated on the same line.`,
        });
        break;
      }
      seen.add(h);
    }

    const emojiMatches = line.match(/\p{Extended_Pictographic}/gu) ?? [];
    if (emojiMatches.length > 2) {
      errors.push({
        rule: "excessive_emoji",
        severity: "error",
        line: idx + 1,
        message: `Line has ${emojiMatches.length} emoji (max 2).`,
      });
    }
  });

  // 4. Progressive-tense chains (3+ bullets using "@handle is <verb>ing")
  const bulletLines = lines.filter((l) => /^[-*•]\s+/.test(l.trim()));
  const progressiveCount = bulletLines.filter((l) => PROGRESSIVE_BULLET.test(l.trim())).length;
  if (progressiveCount >= 3) {
    errors.push({
      rule: "progressive_tense_chain",
      severity: "error",
      message: `${progressiveCount} bullets use "is <verb>ing". Use crisp past or present verbs (shipped, launched, added, hit).`,
    });
  }

  // 5. Chain-name echo (>50% of bullets repeat chain/page name when title already has it)
  const echoTarget = (opts.chainName ?? opts.pageName ?? "").trim();
  if (echoTarget && bulletLines.length >= 4) {
    const re = new RegExp(`\\b${echoTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";
    if (re.test(firstNonEmpty)) {
      const hits = bulletLines.filter((l) => re.test(l)).length;
      if (hits / bulletLines.length > 0.5) {
        errors.push({
          rule: "chain_name_echo",
          severity: "error",
          message: `"${echoTarget}" is repeated in ${hits}/${bulletLines.length} bullets even though the title already names it.`,
        });
      }
    }
  }

  // 6. Empty bookend wrap-up line
  const nonEmptyLines = lines.map((l) => l.trim()).filter(Boolean);
  const lastLine = nonEmptyLines[nonEmptyLines.length - 1] ?? "";
  for (const pat of EMPTY_CLOSERS) {
    if (pat.test(lastLine)) {
      errors.push({
        rule: "empty_closer",
        severity: "error",
        line: lines.length,
        message: "Drop empty wrap-up closing line; end on the last concrete fact.",
      });
      break;
    }
  }

  // 7. Missing source URLs
  const urls = (opts.sourceUrls ?? []).filter((u) => /^https?:\/\//.test(u));
  if (urls.length === 0) {
    errors.push({
      rule: "missing_source_urls",
      severity: "error",
      message: "Every draft must include at least one verified source URL.",
    });
  }

  // 8. Cross-draft hook deduplication
  const hook = nonEmptyLines[0] ?? "";
  if (hook && opts.recentHooks && opts.recentHooks.length > 0) {
    for (const prev of opts.recentHooks) {
      const sim = jaccardSimilarity(hook, prev);
      if (sim >= 0.65) {
        warnings.push({
          rule: "duplicate_hook",
          severity: "warn",
          line: 1,
          message: `Opening hook is ${Math.round(sim * 100)}% similar to a recent hook: "${prev.slice(0, 80)}".`,
        });
        break;
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}
