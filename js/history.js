// Lightweight Undo / Redo manager for current board

export class HistoryManager {
  constructor(maxSteps = 50, onChange = () => {}) {
    this.maxSteps = maxSteps;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
  }

  reset(initialSnapshot) {
    this.undoStack = [this._clone(initialSnapshot)];
    this.redoStack = [];
    this.onChange();
  }

  push(snapshot) {
    this.undoStack.push(this._clone(snapshot));
    if (this.undoStack.length > this.maxSteps) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.onChange();
  }

  canUndo() {
    return this.undoStack.length > 1;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (!this.canUndo()) return null;
    const current = this.undoStack.pop();
    this.redoStack.push(current);
    this.onChange();
    return this._clone(this.undoStack[this.undoStack.length - 1]);
  }

  redo() {
    if (!this.canRedo()) return null;
    const next = this.redoStack.pop();
    this.undoStack.push(next);
    this.onChange();
    return this._clone(next);
  }

  _clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
}
