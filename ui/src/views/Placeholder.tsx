export function Placeholder({ title, lede, milestone, body }: { title: string; lede: string; milestone: string; body: string }) {
  return (
    <>
      <header><div><h1>{title}</h1><p className="lede">{lede}</p></div></header>
      <div className="card empty">
        <h3>Arrives in milestone {milestone}</h3>
        <p>{body}</p>
      </div>
    </>
  );
}
