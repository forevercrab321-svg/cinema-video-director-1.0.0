import type { HubLike, HubRoom, HubSelf, HubView } from '../net/Hub';
import { sortRooms } from '../net/Hub';

/**
 * DEV ONLY (?hub=demo, imported behind import.meta.env.DEV so production bundles never contain
 * it): a fake directory with sample rooms and counts, for screenshots and UI work in a sandbox
 * that cannot reach Supabase. ?hubstate=empty | loading | offline shows the other states.
 */
export function demoHub(state: string | null): HubLike {
  const t = Date.now();
  const room = (code: string, host: string, city: string, humans: number, phase: HubRoom['phase'], ageMin: number, bots = true, leftS: number | null = null): HubRoom => ({
    code, host, city, humans, bots, phase, public: true, since: t - ageMin * 60_000, key: code, max: 4, updatedAt: t, left: leftS,
    joinable: (phase === 'waiting' || phase === 'warmup') && humans < 4, full: humans >= 4, mine: false, endsAt: leftS === null ? 0 : t + leftS * 1000,
  });
  const rooms: HubRoom[] =
    state === 'empty' || state === 'loading' || state === 'offline'
      ? []
      : sortRooms([
          room('K7QX2', '小鹿', 'shanghai', 2, 'waiting', 3),
          room('M3HT8', 'Kenji', 'paris', 1, 'warmup', 6),
          room('P9WZ4', '阿杰', 'newyork', 3, 'playing', 9, true, 143),
          room('R2DN6', 'Luna', 'shanghai', 4, 'playing', 12, true, 212),
          room('T5BV3', 'Mia', 'scrap', 2, 'playing', 4, false, 18),
          room('W8CJ7', 'Sam', 'shanghai', 3, 'waiting', 1),
        ]);
  let source: () => HubSelf = () => ({ room: null, state: 'hub', announce: null });
  const view = (): HubView => {
    const self = source();
    const mine: HubRoom[] = self.announce?.public ? [{ ...self.announce, key: self.announce.code, max: 4, updatedAt: Date.now(), joinable: false, full: self.announce.humans >= 4, mine: true, endsAt: 0 }] : [];
    const list = sortRooms([...mine, ...rooms]);
    return {
      available: state !== 'loading' && state !== 'offline',
      ready: state !== 'loading' && state !== 'offline',
      status: state === 'offline' ? 'error' : state === 'loading' ? 'connecting' : 'connected',
      online: state === 'empty' ? 3 : 23,
      capped: false,
      rooms: list,
      privateRooms: state === 'empty' ? 0 : 2,
      playing: 9,
    };
  };
  return {
    view,
    onChange() {},
    whenReady: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 400))),
    setSource(fn) {
      source = fn;
    },
    onSnapshot: null,
  };
}
