export function singleFlight(run: () => Promise<unknown>): () => void {
  let running = false;
  let wanted = false;

  function settled() {
    running = false;
    if (!wanted) return;
    wanted = false;
    start();
  }

  function start() {
    if (running) {
      wanted = true;
      return;
    }
    running = true;
    new Promise((resolve) => resolve(run())).then(settled, settled);
  }

  return start;
}
