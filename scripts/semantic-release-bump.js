/**
 * Custom semantic-release commit analyzer (ESM — this package is "type":"module").
 *
 * Bump policy (matches answerlayer-core): everything defaults to a patch so
 * automated/LLM-authored commits don't over-inflate the version. Minor and
 * major require explicit opt-in:
 *
 *   fix: / feat: / chore: / docs: / unprefixed ...  -> patch (0.0.X)
 *   feat(minor): <subject>                           -> minor (0.X.0)
 *   `type!:` header or BREAKING CHANGE in the body   -> major (X.0.0)
 *
 * Any push to main with at least one commit produces a release.
 */
const HEADER_PATTERN = /^(?:(\w+)(?:\(([\w$.\-*/ ]*)\))?!?: )?(.+)$/;

function parseHeader(subject = "") {
  const match = subject.match(HEADER_PATTERN);
  if (!match) {
    return { type: "", scope: "", subject };
  }
  return {
    type: match[1] || "",
    scope: match[2] || "",
    subject: match[3] || subject,
  };
}

function releaseTypeForCommit(commit) {
  const message =
    commit.message || `${commit.subject || ""}\n${commit.body || ""}`;
  const subject = commit.subject || message.split("\n")[0] || "";
  const { type, scope } = parseHeader(subject);

  if (/^BREAKING CHANGE:/m.test(message) || /^\w+(?:\([\w$.\-*/ ]*\))?!:/.test(subject)) {
    return "major";
  }

  if (type === "feat" && scope === "minor") {
    return "minor";
  }

  return "patch";
}

function rank(releaseType) {
  return { patch: 1, minor: 2, major: 3 }[releaseType] || 0;
}

export async function analyzeCommits(pluginConfig, context) {
  if (!context.commits || context.commits.length === 0) {
    context.logger.log("No commits since last release; skipping");
    return null;
  }

  return context.commits.reduce((highest, commit) => {
    const next = releaseTypeForCommit(commit);
    return rank(next) > rank(highest) ? next : highest;
  }, "patch");
}
