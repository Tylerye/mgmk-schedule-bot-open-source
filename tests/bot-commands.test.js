import test from "node:test";
import assert from "node:assert/strict";
import { configureGroupCommands, GROUP_COMMANDS } from "../src/bot-commands.js";

test("command menus are scoped to the group and owner and verified in default and Russian languages", async () => {
  const calls = [];
  let saved;
  const client = { async call(method, body) { calls.push({ method, body });
    if (method === "setMyCommands") { saved = body.commands; return true; }
    return structuredClone(saved);
  } };
  await configureGroupCommands(client, "-1001", "42");
  assert.equal(calls.length, 8);
  assert.deepEqual(calls[0].body.commands, GROUP_COMMANDS);
  assert.deepEqual(calls[0].body.scope, { type: "chat", chat_id: "-1001" });
  assert.deepEqual(calls[4].body.scope, { type: "chat_member", chat_id: "-1001", user_id: 42 });
  assert.equal(calls[4].body.commands.at(-1).command, "status");
  assert.equal(calls[4].body.commands[0].command, "all");
  assert.equal(calls[2].body.language_code, "ru");
  assert.equal(calls.some(({method}) => /send|pin|webhook/i.test(method)), false);
});

test("curator has a personal announcement menu without owner status", async () => {
  const menus = []; let saved;
  const client = { async call(method, body) { if (method === "setMyCommands") { saved = body.commands; menus.push(body); return true; } return saved; } };
  await configureGroupCommands(client, "-1001", "42", "44");
  const curator = menus.find(menu => menu.scope.user_id === 44);
  assert.equal(curator.commands[0].command, "all");
  assert.equal(curator.commands.some(command => command.command === "status"), false);
  assert.equal(curator.commands.some(command => command.command === "need"), true);
  assert.equal(curator.commands.some(command => command.command === "remind"), true);
  assert.equal(menus.find(menu => menu.scope.user_id === 42).commands.some(command => command.command === "remind"), true);
  assert.equal(menus[0].commands.some(command => command.command === "remind"), false);
  assert.equal(menus[0].commands.some(command => command.command === "all"), false);
  assert.equal(menus[0].commands.some(command => command.command === "need"), false);
});
test("menu rejects invalid targets and failed verification", async () => {
  const client = { async call() { return []; } };
  await assert.rejects(configureGroupCommands(client, "123", "42"), /negative/);
  await assert.rejects(configureGroupCommands(client, "-1001", undefined), /numeric/);
  await assert.rejects(configureGroupCommands(client, "-1001", "42"), /verification/);
});
