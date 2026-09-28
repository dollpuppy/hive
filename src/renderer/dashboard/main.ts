// Placeholder so the build has a dashboard entry; replaced by the real dashboard in Task 7.
const root = document.getElementById("app")!;
root.textContent = "Hive";
window.hive
  .getState()
  .then((state) => {
    root.textContent = `Hive — ${state.displayName} (port ${state.port})`;
  })
  .catch((err: unknown) => console.error("[hive] dashboard getState failed", err));
