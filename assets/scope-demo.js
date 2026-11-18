// "Try a future" on the home page (17 Nov 2026, Matthew: "the cards on the whiteboard can shuffle around ... move around
// smoothly and uniquely to its new position"): a sample plan on a small whiteboard. Each button is a future RAMenScope
// could show you; the cards hop to where they would land, the ones that slip turn red, and Undo goes back a step. Nothing
// here is saved or sent anywhere: it is the same idea as RAMen Bowl, shown with a sample plan.
(() => {
  const root = document.querySelector("[data-scope-demo]");
  if (!root) return;
  const board = root.querySelector("[data-board]"), say = root.querySelector("[data-say]"), pill = root.querySelector("[data-pill]");
  const undoBtn = root.querySelector("[data-undo]"), futureBtns = [...root.querySelectorAll("[data-future]")];
  const cards = new Map([...board.querySelectorAll("[data-card]")].map((el) => [el.dataset.card, el]));
  const calm = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // where each card sits: [week, row] (this week, next week, the week after), the ones at risk, and what the change did
  const FUTURES = {
    now: { place: { logo: [0, 0], desc: [0, 1], test: [0, 2], shoot: [1, 0], email: [1, 1], open: [2, 0] }, late: [],
      pill: "All on time", say: "Your plan as it is. Try a future: the cards move to where they would land." },
    client: { place: { logo: [0, 0], desc: [1, 0], test: [1, 1], shoot: [1, 2], email: [2, 0], open: [2, 1] }, late: ["email", "open"],
      pill: "2 at risk", say: "Your future moved: 10 hours a week for a client pushes your work back. The launch email and the opening are now at risk." },
    launch: { place: { logo: [0, 0], desc: [0, 1], test: [0, 2], shoot: [1, 0], email: [2, 0], open: [2, 1] }, late: [],
      pill: "All on time", say: "Your future moved: the launch email and the opening move a week. Everything fits, with room to spare." },
    fridays: { place: { logo: [0, 0], desc: [0, 1], test: [1, 0], shoot: [1, 1], email: [1, 2], open: [2, 0] }, late: [],
      pill: "All on time", say: "Your future moved: the checkout test moves to next week, still before the launch email." },
  };
  let now = "now";
  const past = [];
  let touched = false;

  function put(name, animate) {
    const f = FUTURES[name];
    const first = new Map([...cards].map(([id, el]) => [id, el.getBoundingClientRect()]));
    for (const [id, el] of cards) {
      const [c, r] = f.place[id];
      el.style.setProperty("--c", c);
      el.style.setProperty("--r", r);
      el.classList.toggle("late", f.late.includes(id));
    }
    pill.textContent = f.pill;
    pill.classList.toggle("bad", f.late.length > 0);
    say.textContent = f.say;
    for (const b of futureBtns) b.setAttribute("aria-pressed", String(b.dataset.future === name));
    undoBtn.disabled = past.length === 0;
    if (!animate || calm()) return;
    // the shuffle: each card that moved hops on an arc from where it was, tilting the way it travels, one after another
    let i = 0;
    for (const [id, el] of cards) {
      const a = first.get(id), b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const dist = Math.hypot(dx, dy), tilt = Math.max(-7, Math.min(7, -dx / 40)), hop = Math.min(34, 12 + dist / 10);
      el.animate([
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - hop}px) rotate(${tilt}deg) scale(1.06)`, offset: 0.42 },
        { transform: "none" },
      ], { duration: Math.round(Math.min(900, 560 + dist / 2)), delay: i++ * 70, easing: "cubic-bezier(.2, 1.35, .35, 1)", fill: "backwards" });
    }
  }
  function go(name) {
    touched = true;
    if (name === now) return;
    past.push(now);
    now = name;
    put(now, true);
  }
  for (const b of futureBtns) b.addEventListener("click", () => go(b.dataset.future));
  undoBtn.addEventListener("click", () => {
    touched = true;
    if (!past.length) return;
    now = past.pop();
    put(now, true);
    say.textContent = `Undone. ${FUTURES[now].say}`;
  });
  put(now, false);
  // once, when it first comes into view and nobody has pressed anything: a future tried and taken back, to show the idea
  if (!calm() && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((seen) => {
      if (!seen.some((e) => e.isIntersecting)) return;
      io.disconnect();
      setTimeout(() => { if (touched) return; past.push(now); now = "client"; put(now, true);
        setTimeout(() => { if (touched || now !== "client") return; now = past.pop(); put(now, true); say.textContent = `Undone. ${FUTURES[now].say}`; }, 3200); }, 900);
    }, { threshold: 0.6 });
    io.observe(board);
  }
})();
