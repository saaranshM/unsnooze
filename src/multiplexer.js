import tmux from './multiplexers/tmux.js';
import zellij from './multiplexers/zellij.js';
import herdr from './multiplexers/herdr.js';
import { getConfig } from './settings.js';

const NAMES = ['tmux', 'zellij', 'herdr'];

export function createMultiplexerFactory({
  backends = { tmux, zellij, herdr },
  getSetting = () => getConfig('multiplexer'),
  env = process.env,
} = {}) {
  const cache = new Map();

  const prototypeFor = name => {
    if (!NAMES.includes(name) || !backends[name]) {
      throw new Error(`unsnooze: unknown multiplexer "${name}"`);
    }
    if (!cache.has(name)) cache.set(name, backends[name]);
    return cache.get(name);
  };

  const isAvailable = name => {
    try { return prototypeFor(name).available(); } catch { return false; }
  };

  const resolveName = explicit => {
    if (explicit && explicit !== 'auto') return explicit;

    let configured = 'auto';
    try { configured = getSetting() || 'auto'; } catch { /* pre-setting compatibility */ }
    if (configured !== 'auto') return configured;

    if (env.HERDR_ENV) return 'herdr';
    if (env.ZELLIJ) return 'zellij';
    if (env.TMUX) return 'tmux';

    const tmuxInstalled = isAvailable('tmux');
    const zellijInstalled = isAvailable('zellij');
    const herdrInstalled = isAvailable('herdr');
    const installed = [
      ['tmux', tmuxInstalled], ['zellij', zellijInstalled], ['herdr', herdrInstalled],
    ].filter(([, present]) => present).map(([name]) => name);
    if (installed.length === 1) return installed[0];
    return 'tmux';
  };

  const getMultiplexer = (name, { owner = null } = {}) => {
    const prototype = prototypeFor(resolveName(name));
    return prototype.bind ? prototype.bind(owner) : prototype;
  };

  return {
    getMultiplexer,
    available: name => prototypeFor(name).available(),
    inside: name => prototypeFor(name).inside(),
  };
}

const factory = createMultiplexerFactory();

export const getMultiplexer = (...args) => factory.getMultiplexer(...args);
export const available = (...args) => factory.available(...args);
export const inside = (...args) => factory.inside(...args);
