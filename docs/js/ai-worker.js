// Web Worker wrapper around the pure bot search. Messages:
//   { id, type: 'move', state, level, seed }  -> { id, move }
//   { id, type: 'par', key }                  -> { id, par }
import { chooseMove } from './ai.js';
import { deserialize } from './engine.js';
import { makeDaily, computePar } from './daily.js';

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'move') {
      const move = chooseMove(deserialize(msg.state), { level: msg.level, seed: msg.seed });
      self.postMessage({ id: msg.id, move });
    } else if (msg.type === 'par') {
      self.postMessage({ id: msg.id, par: computePar(makeDaily(msg.key)) });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
};
