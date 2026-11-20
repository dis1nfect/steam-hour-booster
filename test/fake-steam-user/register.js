'use strict';
// Loaded with `node --require` in the booster child process. It redirects
// require('steam-user') to the fake without touching node_modules.
const Module = require('node:module');
const FakeSteamUser = require('./index.js');

const originalLoad = Module._load;

Module._load = function load(request, parent, isMain) {
  if (request === 'steam-user') return FakeSteamUser;
  return originalLoad.call(this, request, parent, isMain);
};
