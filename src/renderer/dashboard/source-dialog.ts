import type { DashboardApi, LocalSource, SourceInput } from "../../shared/dashboard-api";
import { DEFAULT_PRESET, type Preset } from "../../shared/presets";
import type { SourceKind } from "../../shared/protocol";
import { h } from "./dom";

const KIND_LABELS: Record<SourceKind, string> = {
  window: "Window / Screen",
  webcam: "Webcam",
  spout: "Spout2",
  url: "Browser URL",
};

const PRESET_LABELS: Record<Preset, string> = {
  low: "Low — 720p 30fps",
  med: "Medium — 1080p 30fps",
  high: "High — 1080p 60fps",
};

export function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    // Unlocks device labels; fails harmlessly if every camera is busy.
    const probe = await navigator.mediaDevices.getUserMedia({ video: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    // Labels may be blank.
  }
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
}

export class SourceDialog {
  private readonly dialog = h("dialog");
  private readonly name = h("input", { type: "text", maxLength: 64, placeholder: "Game" });
  private readonly kindSelect = h("select", { "aria-label": "Type" });
  private readonly presetSelect = h("select", { "aria-label": "Quality" });
  private readonly detail = h("div");
  private readonly error = h("div", { class: "error", role: "alert" });
  private readonly deviceSelect = h("select", { "aria-label": "Camera" });
  private readonly senderSelect = h("select", { "aria-label": "Spout2 sender" });
  private readonly url = h("input", { type: "url", placeholder: "https://…", "aria-label": "URL" });
  private readonly width = h("input", { type: "number", min: "16", max: "3840", value: "1280", "aria-label": "Width" });
  private readonly height = h("input", { type: "number", min: "16", max: "2160", value: "720", "aria-label": "Height" });
  private editing: LocalSource | null = null;
  private kind: SourceKind = "window";
  private presetTouched = false;
  private selectedWindow = "";

  constructor(private readonly api: DashboardApi) {
    for (const k of Object.keys(KIND_LABELS) as SourceKind[]) this.kindSelect.append(h("option", { value: k }, KIND_LABELS[k]));
    for (const p of Object.keys(PRESET_LABELS) as Preset[]) this.presetSelect.append(h("option", { value: p }, PRESET_LABELS[p]));
    this.kindSelect.addEventListener("change", () => {
      this.kind = this.kindSelect.value as SourceKind;
      if (!this.presetTouched) this.presetSelect.value = DEFAULT_PRESET[this.kind];
      void this.renderDetail();
    });
    this.presetSelect.addEventListener("change", () => {
      this.presetTouched = true;
    });
    document.body.append(this.dialog);
  }

  open(existing: LocalSource | null): void {
    this.editing = existing;
    this.kind = existing?.kind ?? "window";
    this.presetTouched = existing !== null;
    this.selectedWindow = existing?.kind === "window" ? existing.windowTitle : "";
    this.error.textContent = "";
    this.name.value = existing?.name ?? "";
    this.kindSelect.value = this.kind;
    this.kindSelect.disabled = existing !== null;
    this.presetSelect.value = existing?.preset ?? DEFAULT_PRESET[this.kind];
    this.url.value = existing?.kind === "url" ? existing.url : "";
    this.width.value = String(existing?.kind === "url" ? existing.width : 1280);
    this.height.value = String(existing?.kind === "url" ? existing.height : 720);

    this.dialog.replaceChildren(
      h("h3", {}, existing ? `Edit ${existing.name}` : "Add source"),
      h("label", {}, "Name"),
      this.name,
      h("label", {}, "Type"),
      this.kindSelect,
      h("label", {}, "Quality"),
      this.presetSelect,
      this.detail,
      this.error,
      h(
        "div",
        { class: "actions" },
        existing ? h("button", { class: "btn-ghost danger", onclick: () => void this.remove() }, "Remove") : null,
        h("span", { class: "spacer" }),
        h("button", { class: "btn-ghost", onclick: () => this.dialog.close() }, "Cancel"),
        h("button", { class: "btn-primary", onclick: () => void this.save() }, existing ? "Save" : "Add source"),
      ),
    );
    void this.renderDetail();
    this.dialog.showModal();
  }

  private async renderDetail(): Promise<void> {
    const kind = this.kind;
    switch (kind) {
      case "window": {
        const grid = h("div", { class: "windows" }, h("div", { class: "status" }, "Loading windows…"));
        this.detail.replaceChildren(
          h("label", {}, "Window"),
          grid,
          h(
            "div",
            { class: "hint" },
            "Matched by the window's exact title — if it's renamed later (e.g. the game changes its title bar), re-pick it here.",
          ),
          h("div", { class: "hint" }, "Exclusive-fullscreen games capture as black — use borderless windowed, or share via OBS's Spout2 filter."),
        );
        const windows = await this.api.listWindows();
        if (this.kind !== kind) return;
        grid.replaceChildren(
          ...windows.map((w) => {
            const button = h(
              "button",
              {
                type: "button",
                class: w.title === this.selectedWindow ? "win selected" : "win",
                title: w.title,
                onclick: () => {
                  this.selectedWindow = w.title;
                  for (const el of grid.children) el.classList.toggle("selected", el === button);
                  if (!this.name.value) this.name.value = w.title.slice(0, 64);
                },
              },
              h("img", { src: w.thumbnail, alt: "" }),
              h("span", {}, w.title),
            );
            return button;
          }),
        );
        break;
      }
      case "webcam": {
        this.detail.replaceChildren(
          h("label", {}, "Camera"),
          this.deviceSelect,
          h("div", { class: "hint" }, "If OBS is already using this camera, add a Spout2 filter to it in OBS and share it as a Spout2 source instead."),
        );
        const cameras = await listCameras();
        if (this.kind !== kind) return;
        this.deviceSelect.replaceChildren(...cameras.map((c, i) => h("option", { value: c.deviceId }, c.label || `Camera ${i + 1}`)));
        if (this.editing?.kind === "webcam") this.deviceSelect.value = this.editing.deviceId;
        break;
      }
      case "spout": {
        this.detail.replaceChildren(
          h("label", {}, "Spout2 sender"),
          this.senderSelect,
          h("div", { class: "hint" }, "Transparency is shared automatically for Spout2 sources."),
        );
        const senders = await this.api.listSpoutSenders();
        if (this.kind !== kind) return;
        const current = this.editing?.kind === "spout" ? this.editing.senderName : null;
        const names = current && !senders.includes(current) ? [current, ...senders] : senders;
        this.senderSelect.replaceChildren(...names.map((n) => h("option", { value: n }, n)));
        if (names.length === 0) this.senderSelect.append(h("option", { value: "" }, "No Spout2 senders running"));
        if (current) this.senderSelect.value = current;
        break;
      }
      case "url":
        this.detail.replaceChildren(
          h("label", {}, "URL"),
          this.url,
          h("div", { class: "pair" }, h("div", {}, h("label", {}, "Width"), this.width), h("div", {}, h("label", {}, "Height"), this.height)),
        );
        break;
    }
  }

  private buildInput(): SourceInput | string {
    const name = this.name.value.trim();
    const preset = this.presetSelect.value as Preset;
    if (!name) return "Enter a name.";
    switch (this.kind) {
      case "window":
        return this.selectedWindow ? { kind: "window", name, preset, windowTitle: this.selectedWindow } : "Pick a window.";
      case "webcam": {
        const option = this.deviceSelect.selectedOptions[0];
        return option?.value
          ? { kind: "webcam", name, preset, deviceId: option.value, deviceLabel: option.textContent ?? "" }
          : "Pick a camera.";
      }
      case "spout":
        return this.senderSelect.value ? { kind: "spout", name, preset, senderName: this.senderSelect.value } : "Pick a Spout2 sender.";
      case "url":
        return {
          kind: "url",
          name,
          preset,
          url: this.url.value.trim(),
          width: Number(this.width.value),
          height: Number(this.height.value),
        };
    }
  }

  private async save(): Promise<void> {
    const input = this.buildInput();
    if (typeof input === "string") {
      this.error.textContent = input;
      return;
    }
    try {
      if (this.editing) await this.api.updateSource(this.editing.id, input);
      else await this.api.addSource(input);
      this.dialog.close();
    } catch (err) {
      this.error.textContent = cleanError(err);
    }
  }

  private async remove(): Promise<void> {
    if (!this.editing) return;
    await this.api.removeSource(this.editing.id);
    this.dialog.close();
  }
}
