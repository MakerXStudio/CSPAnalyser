export function LazyPanel() {
  return (
    <section className="lazy-panel" data-testid="lazy-panel">
      <h3>Lazy scenario panel</h3>
      <p>This chunk is loaded through a dynamic import to exercise script-src-elem.</p>
    </section>
  );
}

export default LazyPanel;
