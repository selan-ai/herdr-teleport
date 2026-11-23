// Moves a space from this computer to another machine: its Claude Code session and the repository
// it works in go by `selan teleport --pid <its process> --json` (selan 1.36 or later), then the space opens there,
// resuming the session, and closes here.
// Opened as a dialog with props { space, tab?, machine }, as a sidebar does when a space, or one chat
// (tab) of it, is dropped on a machine; opened bare (mod.open, a key), it moves the active space and asks where to when more than
// one machine could take it. Enter moves, Esc cancels.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, spaces, hc, exec, run, props, closeOverlay, theme, checking } from "herdr";

// A long session's transcript is tens of megabytes, and it may cross a tunnel: the most exec waits.
const TIMEOUT_MS = 600_000;
const OLD = "This selan cannot move a session for Herdr: it needs selan 1.36 or later. Run selan update.";

/** What a drop asks: the one Claude Code agent of a space on this computer, its process and the folder
 *  it runs in; or why that space cannot go to that machine. */
class Plan {
  /** The machines a space can go to: another one, connected, reached over ssh. */
  static targets(machines) {
    return machines.filter((m) => !m.temporary && !m.via && m.state === "connected");
  }

  static of(spaceId, name, machines, tab) {
    const space = spaces().find((s) => s.id === spaceId);
    if (!space) return { why: "That space is gone." };
    if (space.machine) return { why: "Teleport moves a space from this computer." };
    const machine = machines.find((m) => m.name === name);
    if (!machine) return { why: `${name} is not one of your machines.` };
    if (machine.via) return { why: `${name} is reached by a command, and teleport needs ssh.` };
    if (machine.state !== "connected") return { why: `${name} is not connected.` };
    const what = tab ? "chat" : "space";
    const here = agents().filter((a) => a.space === spaceId && (!tab || a.tab === tab) && a.program?.key === "claude");
    if (here.length === 0) return { why: `There is no Claude Code agent in this ${what} to move.` };
    if (here.length > 1) return { why: `This ${what} has ${here.length} Claude Code agents, and teleport moves one.` };
    const [agent] = here;
    if (agent.status === "working") return { why: "Claude Code is working. Move it once it is done." };
    // A chat of a space with other tabs closes alone; the last one closes its space.
    const alone = !tab || (space.tabs ?? []).length <= 1;
    return { space, target: machine.target, agent: agent.address, close: alone ? { name: "space.close", args: { id: space.id, confirmed: true } } : { name: "tab.close", args: { id: tab, confirmed: true } } };
  }

  /** The agent's process, which names its session to selan, and the folder it runs in, which is
   *  where Claude Code keeps that session; or why Herdr cannot tell. */
  static async process(plan) {
    let fg;
    try {
      const r = await hc(["get", plan.agent, "--json"]);
      if (r.code === 0) fg = JSON.parse(r.stdout).foreground;
    } catch {}
    const folder = fg?.cwd ?? panes().find((p) => p.terminal === plan.agent)?.cwd;
    if (!fg?.pid || !folder) return { why: "Herdr cannot tell which Claude Code process the agent is." };
    return { ...plan, pid: fg.pid, folder };
  }
}

/** The Selan CLI, run as the person: the session moved, or why not. Never a throw. */
class Selan {
  static async teleport(plan) {
    let r;
    try {
      r = await exec("selan", ["teleport", plan.target, "--pid", String(plan.pid), "--json"], { cwd: plan.folder, timeout: TIMEOUT_MS });
    } catch (err) {
      return { error: `selan did not run (${String(err?.message ?? err)}). Is the Selan CLI installed and on PATH?` };
    }
    let out;
    try {
      out = JSON.parse(r.stdout.trim().split("\n").pop());
    } catch {
      return { error: OLD };
    }
    if (typeof out.error === "string") return { error: out.error.startsWith("usage:") ? OLD : out.error };
    return Array.isArray(out.resume) && out.folder ? out : { error: OLD };
  }
}

export default class Teleport extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.state = { kind: "loading" };
    if (checking()) return;
    cx.spawn(async (cx) => {
      let machines = [];
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) machines = JSON.parse(r.stdout).machines ?? [];
      } catch {}
      const p = props() ?? {};
      this.machines = machines;
      this.space = p.space ?? spaces().find((s) => s.active)?.id;
      const targets = Plan.targets(machines);
      if (p.machine) this.choose(p.machine, cx);
      else if (targets.length === 1) this.choose(targets[0].name, cx);
      else if (targets.length === 0) this.state = { kind: "refused", why: "No other machine is connected over ssh. Add one in Settings, under Machines." };
      else this.state = { kind: "choosing", targets };
      cx.notify();
    });
  }

  choose(machine, cx) {
    const plan = Plan.of(this.space, machine, this.machines, props()?.tab);
    if (plan.why) {
      this.state = { kind: "refused", why: plan.why };
      return;
    }
    this.state = { kind: "loading" };
    cx.spawn(async (cx) => {
      const found = await Plan.process(plan);
      this.state = found.why ? { kind: "refused", why: found.why } : { kind: "ready", plan: found, machine };
      cx.notify();
    });
  }

  move(cx) {
    if (this.state.kind !== "ready") return;
    const { plan } = this.state;
    this.state = { kind: "moving", plan, machine: this.state.machine };
    cx.notify();
    cx.spawn(async (cx) => {
      const out = await Selan.teleport(plan);
      if (out.error) {
        this.state = { kind: "refused", why: out.error };
        cx.notify();
        return;
      }
      run("space.new", { machine: this.state.machine, folder: out.folder, argv: out.resume, focus: true });
      run(plan.close.name, plan.close.args);
      closeOverlay(props()?.overlay);
    });
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const s = this.state;
    const name = s.plan?.space.name ?? spaces().find((w) => w.id === this.space)?.name ?? "This space";
    const title = { refused: `Couldn't move ${name}`, choosing: `Move ${name} to…`, loading: `Move ${name}` }[s.kind] ?? `Move ${name} to ${s.machine}?`;
    // The names line up with the title; a row's hover reaches past them.
    const rows = (targets) => v_flex().mx(-10).children(targets.map((m, i) => h_flex().id(`to-${m.name}`).h(34).px(10).items_center().rounded(7)
      .text_color(t.foreground).cursor_pointer().hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.choose(m.name, cx); cx.notify(); }).child(m.name)));
    const detail = {
      loading: "",
      choosing: s.targets && rows(s.targets),
      ready: `The Claude Code session goes with its repository: the branch and the work not committed yet. Ignored files such as .env stay here. It opens on ${s.machine} and closes here.`,
      moving: `Moving to ${s.machine}…`,
      refused: s.why,
    }[s.kind];
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "move" ? bg : t.input).bg(bg).text_color(fg)
        .cursor_pointer().hover((st) => st.opacity(0.88)).on_click(onClick).child(label);
    const close = () => closeOverlay(props().overlay);
    return v_flex()
      .id("teleport")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (s.kind === "moving") return;
        if (e.key === "enter" && s.kind === "ready") this.move(cx);
        else if (e.key === "escape" || e.key === "enter") close();
        else return;
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .rounded(8)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(title))
        .when(s.kind !== "moving", (el) => el.child(div().text_size(11).text_color(t.dim).child("Esc"))))
      .child(h_flex().flex_1().min_h(0).gap(8).items_start().text_color(t.muted)
        .when(s.kind === "moving", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(13).mt(2).flex_none().text_color(t.working).spin(900)))
        .child(div().flex_1().min_w(0).min_h(0).overflow_y_scrollbar().child(detail)))
      .when(s.kind !== "moving" && s.kind !== "loading", (el) => el.child(h_flex().justify_end().gap(8).text_size(12)
        .when(s.kind === "ready", (row) => row
          .child(button("cancel", "Cancel", t.raised, t.foreground, close))
          .child(button("move", "Move", t.solid, t.solid_foreground, (_e, cx) => this.move(cx))))
        .when(s.kind === "refused" || s.kind === "choosing", (row) => row.child(button("close", s.kind === "choosing" ? "Cancel" : "Close", t.raised, t.foreground, close)))));
  }
}
