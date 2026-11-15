#!/usr/bin/env node
/**
 * Generate a password hash for Tree's admin login.
 *
 * Usage:
 *   node bin/set-admin-password.mjs            # prompts twice, input hidden
 *   node bin/set-admin-password.mjs <password> # non-interactive (ends up in
 *                                              # shell history; prefer prompt)
 *
 * Prints the hash. Copy it into .env as TREE_ADMIN_PASSWORD_HASH and set
 * TREE_ADMIN_USER (default: tree). The plain password is never printed or
 * stored by this script.
 */
import { createInterface } from 'node:readline';
import { hashPassword } from '../server/src/lib/password.ts';

function readHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(prompt);
    let input = '';
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\n' || ch === '\r') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdout.write('\n');
          rl.close();
          resolve(input);
          return;
        }
        if (ch === '\u0003') { // Ctrl-C
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f') { // Backspace
          input = input.slice(0, -1);
        } else {
          input += ch;
        }
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on('data', onData);
  });
}

const argPassword = process.argv[2];
let password;
if (argPassword) {
  password = argPassword;
} else {
  password = await readHidden('New admin password: ');
  if (!password) {
    console.error('Empty password, aborted.');
    process.exit(1);
  }
  const confirm = await readHidden('Repeat admin password: ');
  if (confirm !== password) {
    console.error('Passwords do not match, aborted.');
    process.exit(1);
  }
}

console.log('\nAdd these two lines to .env (TREE_ADMIN_USER defaults to "tree"):');
console.log(`TREE_ADMIN_USER=tree`);
console.log(`TREE_ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
