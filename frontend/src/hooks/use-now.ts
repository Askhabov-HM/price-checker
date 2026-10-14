import {useEffect, useState} from 'react';

export function useNow() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const update = () => setTick(tick => tick + 1);
    const timer = window.setInterval(update, 60000);
    document.addEventListener('visibilitychange', update);
    return () => {window.clearInterval(timer); document.removeEventListener('visibilitychange', update);};
  }, []);
  // Read the current clock when API data changes as well as during idle ticks.
  return Date.now();
}
