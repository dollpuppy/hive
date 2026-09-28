import type { DashboardApi, DashboardState } from "../../shared/dashboard-api";
import { h } from "./dom";
import { cleanError } from "./source-dialog";

export class SettingsDialog {
  private readonly dialog = h("dialog");
  private readonly name = h("input", { type: "text", maxLength: 64 });
  private readonly turnUrl = h("input", { type: "text", placeholder: "turn:turn.example.com:3478" });
  private readonly turnUser = h("input", { type: "text", autocomplete: "off" });
  private readonly turnCredential = h("input", { type: "password", autocomplete: "off" });
  private readonly keepSecret = h("input", { type: "checkbox" });
  private readonly error = h("div", { class: "error", role: "alert" });

  constructor(private readonly api: DashboardApi) {
    document.body.append(this.dialog);
  }

  open(state: DashboardState): void {
    this.name.value = state.displayName;
    this.turnUrl.value = state.settings.turn?.url ?? "";
    this.turnUser.value = state.settings.turn?.username ?? "";
    this.turnCredential.value = state.settings.turn?.credential ?? "";
    this.keepSecret.checked = state.settings.keepSecret;
    this.error.textContent = "";
    this.dialog.replaceChildren(
      h("h3", {}, "Settings"),
      h("label", {}, "Display name"),
      this.name,
      h("div", { class: "hint" }, "Your partner sees this name. Changes apply the next time you connect."),
      h("label", {}, "TURN server (optional)"),
      this.turnUrl,
      h("div", { class: "pair" }, h("div", {}, h("label", {}, "Username"), this.turnUser), h("div", {}, h("label", {}, "Credential"), this.turnCredential)),
      h("div", { class: "hint" }, "Only needed if Hive says the direct connection failed."),
      h("label", { class: "toggle" }, this.keepSecret, "Keep my invite link's secret the same between sessions"),
      this.error,
      h(
        "div",
        { class: "actions" },
        h("span", { class: "spacer" }),
        h("button", { class: "btn-ghost", onclick: () => this.dialog.close() }, "Cancel"),
        h("button", { class: "btn-primary", onclick: () => void this.save() }, "Save"),
      ),
    );
    this.dialog.showModal();
  }

  private async save(): Promise<void> {
    const url = this.turnUrl.value.trim();
    try {
      await this.api.updateSettings({
        displayName: this.name.value,
        turn: url ? { url, username: this.turnUser.value, credential: this.turnCredential.value } : null,
        keepSecret: this.keepSecret.checked,
      });
      this.dialog.close();
    } catch (err) {
      this.error.textContent = cleanError(err);
    }
  }
}
