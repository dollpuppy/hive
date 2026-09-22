import { app } from "electron";

app.whenReady().then(() => {
  console.log("Hive starting");
  app.quit();
});
