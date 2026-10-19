#!/usr/bin/env node
// Entry point for the ig-unsend command.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 17)) {
  console.error(`IG Unsend needs Node.js 20.17 or newer (you have ${process.versions.node}). Get it from https://nodejs.org`);
  process.exit(1);
}

const { main } = await import('../src/cli.mjs');
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
