// One command instead of a walk through GitHub's settings: the App Manifest
// flow. Sprowi hands GitHub the whole App definition — permissions, no webhook,
// private by default — GitHub creates it in the person's own account, and
// hands the private key back exactly once, in the redirect. That one moment is
// the only time a key is available programmatically, so it is stored here and
// the flow ends.
//
// Nothing in this file is specific to this machine's App: it is what a second
// person setting Sprowi up would run, and it leaves them owning their own App.

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubSlug, gitRemote, hubRoot } from "./lib.mjs";

const PORT = 8787;
const REDIRECT = `http://localhost:${PORT}/callback`;

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#1f2328}
code{background:#f0f1f3;padding:.1em .35em;border-radius:4px}button{font:inherit;padding:.6em 1.2em;border-radius:6px;border:0;background:#1f883d;color:#fff;cursor:pointer}</style>
<h1>${title}</h1>${body}`;
}

// The App is created private ("public": false), with no webhook and with the
// two permissions publishing actually uses. Anything more would be a promise
// to the person installing it that Sprowi does not need to make.
function manifest(name, homepage) {
  return {
    name,
    url: homepage,
    redirect_url: REDIRECT,
    public: false,
    hook_attributes: { url: `${homepage}#sprowi-uses-no-webhook`, active: false },
    default_permissions: { contents: "write", pull_requests: "write" },
    default_events: [],
  };
}

function storeKey(service, pem) {
  const encoded = Buffer.from(pem, "utf8").toString("base64");
  // Through stdin rather than argv: an argument is readable by every process
  // on the machine for as long as the call runs.
  const result = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -a "${process.env.USER}" -s ${service} -w "${encoded}"\n`,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("Could not store the key in the Keychain. App configuration was not changed.");
  }
}

function writeAppId(id) {
  const path = join(hubRoot, "sprowi/config.default.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.publish.app.id = id;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, keyService: config.publish.app.keyService };
}

export async function githubSetup({ name, org } = {}) {
  const slug = githubSlug(gitRemote(hubRoot));
  const homepage = slug ? `https://github.com/${slug}` : "https://github.com";
  const appName = name ?? `sprowi-${(slug ?? "factory").split("/")[0]}`;
  const target = org
    ? `https://github.com/organizations/${org}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const state = randomBytes(16).toString("hex");
  const definition = escapeAttribute(JSON.stringify(manifest(appName, homepage)));

  const outcome = await new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, `http://localhost:${PORT}`);

      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          page(
            `Create the GitHub App <code>${escapeAttribute(appName)}</code>`,
            `<p>GitHub will show you what it is about to create: read access to metadata,
             read and write to contents and pull requests, no webhook, visible only to you.</p>
             <form action="${target}?state=${state}" method="post">
               <input type="hidden" name="manifest" value="${definition}">
               <button type="submit">Create it on GitHub</button>
             </form>`,
          ),
        );
        return;
      }

      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }

      // The code is single-use and expires in an hour; the state is the only
      // thing tying this redirect to the form this process served.
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(page("That redirect did not come from here", "<p>Run the command again.</p>"));
        return;
      }

      try {
        const conversion = await fetch(
          `https://api.github.com/app-manifests/${url.searchParams.get("code")}/conversions`,
          { method: "POST", headers: { accept: "application/vnd.github+json" } },
        );
        const app = await conversion.json();
        if (!conversion.ok) throw new Error(app.message ?? `GitHub answered ${conversion.status}`);

        const config = JSON.parse(readFileSync(join(hubRoot, "sprowi/config.default.json"), "utf8"));
        const keyService = config.publish.app.keyService;
        storeKey(keyService, app.pem);
        const { path } = writeAppId(app.id);

        const install = `https://github.com/apps/${app.slug}/installations/new`;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          page(
            `${app.slug} is yours`,
            `<p>The key is in your Keychain as <code>${keyService}</code>, and the App ID is in
             <code>${path.replace(hubRoot + "/", "")}</code>.</p>
             <p>One thing left: <a href="${install}">install it on the repositories</a> Sprowi should publish to.</p>`,
          ),
        );
        server.close();
        resolve({ app, install, keyService, path });
      } catch (error) {
        response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
        response.end(page("That did not work", `<p><code>${escapeAttribute(error.message)}</code></p>`));
        server.close();
        reject(error);
      }
    });

    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Opening http://localhost:${PORT}/ — create the App there.`);
      spawnSync("open", [`http://localhost:${PORT}/`]);
    });
    server.on("error", reject);
    // Nobody should be left with a stray server because they wandered off.
    setTimeout(() => {
      server.close();
      reject(new Error("Nothing came back within five minutes. Run the command again."));
    }, 5 * 60 * 1000).unref();
  });

  console.log(`\nApp ${outcome.app.slug} (id ${outcome.app.id}) created.`);
  console.log(`Key stored in the Keychain as ${outcome.keyService}, App ID written to ${outcome.path}.`);
  console.log(`Now install it on the repositories Sprowi publishes to:\n  ${outcome.install}`);
}
