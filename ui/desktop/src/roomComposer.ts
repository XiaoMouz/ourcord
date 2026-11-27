type ComposerState = { text: string; revision: number; pending: "send" | "upload" | null };

// The room owns its draft and pending operation even while a voice stage is open.
export class RoomComposer {
  private state: ComposerState = { text: "", revision: 0, pending: null };
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = () => this.state;

  private update(next: ComposerState) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  edit(text: string) {
    this.update({ ...this.state, text, revision: this.state.revision + 1 });
  }

  begin(pending: "send" | "upload") {
    if (this.state.pending) return null;
    this.update({ ...this.state, pending });
    return this.state;
  }

  sent(revision: number) {
    if (revision === this.state.revision) this.edit("");
  }

  finish() {
    this.update({ ...this.state, pending: null });
  }
}
