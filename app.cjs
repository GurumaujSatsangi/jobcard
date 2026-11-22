// Startup file for cPanel "Setup Node.js App" (Phusion Passenger).
// Passenger loads the startup file with require(), which can't load this
// project's ES modules directly, so this CommonJS file imports the real server.
import("./src/server.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
