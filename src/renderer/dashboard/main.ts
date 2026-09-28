import "../../shared/dashboard-api";
import type { DashboardState, LocalSource } from "../../shared/dashboard-api";
import { spoutOutputName } from "../../shared/spout-name";
import type { SourceInfo, SourceStatus } from "../../shared/protocol";
import { h } from "./dom";
import { PreviewPool } from "./previews";
import { SettingsDialog } from "./settings-dialog";
import { SourceDialog, cleanError } from "./source-dialog";

const api = window.hive;
const root = document.getElementById("app") as HTMLDivElement;
let state: DashboardState = await api.getState();
let tab: "partner" | "mine" = state.partner ? "partner" : "mine";
let copied: string | null = null;
let joinError = "";

const previews = new PreviewPool(() => state.port);
const sourceDialog = new SourceDialog(api);
const settingsDialog = new SettingsDialog(api);
const inviteInput = h("input", { class: "invite-input", placeholder: "Paste partner's invite link…", spellcheck: false, "aria-label": "Partner's invite link" });
inviteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void doJoin();
});

api.onState((next) => {
  const hadPartner = state.partner !== null;
  state = next;
  if (!hadPartner && next.partner) tab = "partner";
  if (!next.partner && tab === "partner") tab = "mine";
  render();
});

async function doJoin(): Promise<void> {
  const link = inviteInput.value.trim();
  if (!link) return;
  joinError = "";
  try {
    await api.join(link);
    inviteInput.value = "";
  } catch (err) {
    joinError = cleanError(err);
  }
  render();
}

function copy(key: string, text: string): void {
  void api.copy(text);
  copied = key;
  render();
  setTimeout(() => {
    if (copied !== key) return;
    copied = null;
    render();
  }, 1200);
}

const viewerUrl = (peer: string, slug: string): string => `http://localhost:${state.port}/s/${peer}/${slug}`;
const watchable = (s: SourceStatus): boolean => s === "live" || s === "idle";

function statusTag(status: SourceStatus): HTMLElement {
  switch (status) {
    case "live":
      return h("span", { class: "tag live" }, "● live");
    case "idle":
      return h("span", { class: "tag" }, "ready");
    case "waiting":
      return h("span", { class: "tag warn" }, "waiting for sender");
    case "unavailable":
      return h("span", { class: "tag warn" }, "unavailable");
  }
}

/** Human text for a rejection/failure detail, shared between the "failed" and "rejected" join statuses. */
function joinDetailText(detail: DashboardState["join"]["detail"]): string | undefined {
  switch (detail) {
    case "invalid-link":
      return "That invite link isn't valid.";
    case "already-partnered":
      return "You're already connected to a partner.";
    case "bad-secret":
      return "That invite link has expired.";
    case "version":
      return "Your partner is on a different Hive version.";
    case "full":
      return "Your partner already has someone connected.";
    case "kicked":
      return "Your partner disconnected you.";
    default:
      return undefined;
  }
}

function joinStatusText(): string {
  const { status, detail } = state.join;
  switch (status) {
    case "connecting":
      return "Joining…";
    case "reconnecting":
      return "Reconnecting…";
    case "failed":
      return joinDetailText(detail) ?? "Couldn't reach your partner.";
    case "rejected":
      return joinDetailText(detail) ?? "Your partner declined the connection.";
    default:
      return joinError;
  }
}

function renderBanners(): HTMLElement[] {
  return state.banners.map((b) =>
    h(
      "div",
      { class: "banner", role: "status" },
      h("span", { class: "msg" }, b.message),
      b.id === "tunnel-failed" ? h("button", { class: "btn-ghost", onclick: () => void api.startServer() }, "Retry") : null,
      h("button", { class: "btn-ghost", "aria-label": "Dismiss", onclick: () => void api.dismissBanner(b.id) }, "×"),
    ),
  );
}

function renderTop(): HTMLElement {
  const s = state.server;
  const running = s.status !== "stopped" && s.status !== "failed";
  const serverStatus = { stopped: "", starting: "Starting tunnel…", up: "", restarting: "Reconnecting tunnel…", failed: "" }[s.status];
  const joined = state.join.status === "connecting" || state.join.status === "connected" || state.join.status === "reconnecting";
  const joinText = joinStatusText();
  return h(
    "div",
    { class: "top" },
    running
      ? h("button", { class: "btn-outline-bad", onclick: () => void api.stopServer() }, "Stop Server")
      : h("button", { class: "btn-outline-ok", onclick: () => void api.startServer() }, "Start Server"),
    h(
      "button",
      { class: "btn-primary", disabled: !s.inviteLink, onclick: () => s.inviteLink && copy("invite", s.inviteLink) },
      copied === "invite" ? "Copied!" : "Copy invite link",
    ),
    serverStatus ? h("span", { class: "status" }, serverStatus) : null,
    h("span", { class: "spacer" }),
    joinText ? h("span", { class: "status" }, joinText) : null,
    joined
      ? h("button", { class: "btn-ghost", onclick: () => void api.leave() }, "Leave")
      : [inviteInput, h("button", { class: "btn-ghost", onclick: () => void doJoin() }, "Join")],
    h("button", { class: "btn-ghost", title: "Settings", "aria-label": "Settings", onclick: () => settingsDialog.open(state) }, "⚙"),
  );
}

function renderTabs(): HTMLElement {
  const tabButton = (id: "partner" | "mine", ...label: (string | HTMLElement)[]): HTMLElement =>
    h(
      "button",
      { class: tab === id ? "tab active" : "tab", role: "tab", "aria-selected": String(tab === id), onclick: () => ((tab = id), render()) },
      ...label,
    );
  return h(
    "div",
    { class: "tabs", role: "tablist" },
    state.partner ? tabButton("partner", state.partner.name, h("span", { class: "dot", "aria-hidden": "true" })) : null,
    tabButton("mine", `My sources (${state.sources.length})`),
  );
}

function partnerRow(partner: NonNullable<DashboardState["partner"]>, src: SourceInfo, keys: Set<string>): HTMLElement {
  const key = `${partner.slug}/${src.slug}`;
  const canWatch = watchable(src.status);
  if (canWatch) keys.add(key);
  const spoutOn = state.spoutOut.some((k) => k.partnerSlug === partner.slug && k.sourceSlug === src.slug);
  const spoutError = state.spoutOutErrors[key];
  return h(
    "div",
    { class: "row" },
    canWatch ? previews.get(partner.slug, src.slug) : h("div", { class: "thumb" }),
    h(
      "div",
      { class: "meta" },
      h("b", {}, src.name),
      h(
        "span",
        { class: "sub" },
        statusTag(src.status),
        src.alpha ? h("span", { class: "tag alpha" }, "alpha") : null,
        `${src.width}×${src.height} · ${src.fps}fps · OBS size ${src.width}×${src.height}`,
      ),
      spoutOn ? h("span", { class: "sub" }, `Spout sender: ${spoutOutputName(partner.name, src.name)}`) : null,
    ),
    h(
      "div",
      { class: "spout-col" },
      h(
        "label",
        { class: "toggle" },
        h("input", {
          type: "checkbox",
          checked: spoutOn,
          onchange: (e: Event) => void api.setSpoutOut(partner.slug, src.slug, (e.target as HTMLInputElement).checked),
        }),
        "Spout out",
      ),
      spoutError ? h("div", { class: "error", role: "alert" }, spoutError) : null,
    ),
    h("button", { class: "btn-primary", onclick: () => copy(key, viewerUrl(partner.slug, src.slug)) }, copied === key ? "Copied!" : "Copy URL"),
  );
}

function renderPartner(partner: NonNullable<DashboardState["partner"]>, keys: Set<string>): HTMLElement {
  return h(
    "div",
    { class: "body" },
    h(
      "div",
      { class: "partner-head" },
      h("span", { class: "status" }, `Connected to ${partner.name}`),
      h("button", { class: "btn-ghost danger", onclick: () => void api.kick() }, "Disconnect partner"),
    ),
    partner.sources.length === 0 ? h("div", { class: "empty" }, `${partner.name} hasn't added any sources yet.`) : null,
    partner.sources.map((s) => partnerRow(partner, s, keys)),
  );
}

function detailOf(s: LocalSource): string {
  switch (s.kind) {
    case "window":
      return `Window: ${s.windowTitle}`;
    case "webcam":
      return s.deviceLabel || "Webcam";
    case "spout":
      return `Spout2: ${s.senderName}`;
    case "url":
      try {
        return new URL(s.url).host;
      } catch {
        return s.url;
      }
  }
}

function mineRow(s: LocalSource, keys: Set<string>): HTMLElement {
  const key = `me/${s.slug}`;
  const canWatch = watchable(s.status);
  if (canWatch) keys.add(key);
  const watching = state.watchers[s.id] ?? 0;
  return h(
    "div",
    { class: "row" },
    canWatch ? previews.get("me", s.slug) : h("div", { class: "thumb" }),
    h(
      "div",
      { class: "meta" },
      h("b", {}, s.name),
      h(
        "span",
        { class: "sub" },
        statusTag(s.status),
        h("span", { class: "tag" }, detailOf(s)),
        s.kind === "spout" ? h("span", { class: "tag alpha" }, "alpha") : null,
        `${s.preset === "low" ? "Low" : s.preset === "med" ? "Medium" : "High"}${watching ? ` · ${watching} watching` : ""}`,
      ),
    ),
    s.status === "unavailable" ? h("button", { class: "btn-ghost", onclick: () => void api.retrySource(s.id) }, "Retry") : null,
    h("button", { class: "btn-ghost", onclick: () => sourceDialog.open(s) }, "Edit"),
  );
}

function renderMine(keys: Set<string>): HTMLElement {
  return h(
    "div",
    { class: "body" },
    state.sources.map((s) => mineRow(s, keys)),
    h("button", { class: "add", onclick: () => sourceDialog.open(null) }, "+ Add source"),
    state.partner ? null : h("div", { class: "empty" }, "No partners yet — start the server and send your invite link, or paste theirs."),
  );
}

function render(): void {
  const focused = document.activeElement === inviteInput;
  const selection = [inviteInput.selectionStart, inviteInput.selectionEnd] as const;
  const keys = new Set<string>();
  const content = tab === "partner" && state.partner ? renderPartner(state.partner, keys) : renderMine(keys);
  root.replaceChildren(...renderBanners(), renderTop(), renderTabs(), content);
  previews.retain(keys);
  if (focused) {
    inviteInput.focus();
    inviteInput.setSelectionRange(selection[0], selection[1]);
  }
}

render();
