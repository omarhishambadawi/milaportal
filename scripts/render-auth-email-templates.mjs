/**
 * Renders the branded React Email templates to static GoTrue mail templates.
 *
 * Today Cloud GoTrue posts to /lovable/email/auth/webhook, which renders these
 * same components per message. Self-hosted GoTrue has no webhook: it sends over
 * SMTP and fetches each template from a URL (GOTRUE_MAILER_TEMPLATES_*), so the
 * branding has to exist as static HTML with GoTrue's own Go placeholders where
 * the per-message values go.
 *
 * Rendering from the same components rather than hand-copying the markup keeps
 * one source of branding: change a template, re-run this, both paths move.
 *
 * Usage: npm run build:auth-email-templates
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";
import { render } from "@react-email/render";
import { createElement } from "react";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "public", "auth-email-templates");

/** GoTrue's per-message template variables (internal/mailer/templatemailer). */
const CONFIRMATION_URL = "{{ .ConfirmationURL }}";
const SITE_URL = "{{ .SiteURL }}";
const EMAIL = "{{ .Email }}";
const NEW_EMAIL = "{{ .NewEmail }}";
const TOKEN = "{{ .Token }}";

/** Matches SITE_NAME in src/routes/lovable/email/auth/webhook.ts. */
const SITE_NAME = "MilaPortal";

/**
 * Output file name = the GoTrue template key, so the env var a file belongs to
 * is readable from its name: recovery.html → GOTRUE_MAILER_TEMPLATES_RECOVERY.
 */
const TEMPLATES = [
  {
    out: "recovery",
    module: "src/lib/email-templates/recovery.tsx",
    export: "RecoveryEmail",
    props: { siteName: SITE_NAME, confirmationUrl: CONFIRMATION_URL },
  },
  {
    out: "confirmation",
    module: "src/lib/email-templates/signup.tsx",
    export: "SignupEmail",
    props: {
      siteName: SITE_NAME,
      siteUrl: SITE_URL,
      recipient: EMAIL,
      confirmationUrl: CONFIRMATION_URL,
    },
  },
  {
    out: "invite",
    module: "src/lib/email-templates/invite.tsx",
    export: "InviteEmail",
    props: { siteName: SITE_NAME, siteUrl: SITE_URL, confirmationUrl: CONFIRMATION_URL },
  },
  {
    out: "magic_link",
    module: "src/lib/email-templates/magic-link.tsx",
    export: "MagicLinkEmail",
    props: { siteName: SITE_NAME, confirmationUrl: CONFIRMATION_URL },
  },
  {
    out: "email_change",
    module: "src/lib/email-templates/email-change.tsx",
    export: "EmailChangeEmail",
    props: {
      siteName: SITE_NAME,
      oldEmail: EMAIL,
      email: EMAIL,
      newEmail: NEW_EMAIL,
      confirmationUrl: CONFIRMATION_URL,
    },
  },
  {
    out: "reauthentication",
    module: "src/lib/email-templates/reauthentication.tsx",
    export: "ReauthenticationEmail",
    props: { token: TOKEN },
  },
];

/** Bundles the .tsx templates so this plain .mjs can import them. */
async function loadComponents(bundleDir) {
  const entry = TEMPLATES.map(
    (t, i) => `export { ${t.export} as T${i} } from "./${t.module}";`,
  ).join("\n");
  const outfile = join(bundleDir, "templates.mjs");

  await esbuild.build({
    stdin: { contents: entry, resolveDir: repoRoot, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    jsx: "automatic",
    outfile,
    logLevel: "warning",
  });

  return import(pathToFileURL(outfile).href);
}

// Inside the repo, so the bundle's external imports (react, @react-email/*)
// resolve against this project's own node_modules.
const cacheDir = join(repoRoot, "node_modules", ".cache");
await mkdir(cacheDir, { recursive: true });
const bundleDir = await mkdtemp(join(cacheDir, "auth-email-templates-"));
try {
  const components = await loadComponents(bundleDir);
  await mkdir(outDir, { recursive: true });

  for (const [i, template] of TEMPLATES.entries()) {
    const html = await render(createElement(components[`T${i}`], template.props), {
      pretty: true,
    });
    await writeFile(join(outDir, `${template.out}.html`), `${html.trimEnd()}\n`, "utf8");
    console.log(`rendered public/auth-email-templates/${template.out}.html`);
  }
} finally {
  await rm(bundleDir, { recursive: true, force: true });
}
