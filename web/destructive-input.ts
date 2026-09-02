export class DestructiveInputGuard {
  private confirmationUntil = -Infinity;

  constructor(private readonly confirmationWindow = 3_000) {}

  confirm(now: number): boolean {
    if (now < this.confirmationUntil) {
      this.confirmationUntil = -Infinity;
      return true;
    }
    this.confirmationUntil = now + this.confirmationWindow;
    return false;
  }

  reset(): void {
    this.confirmationUntil = -Infinity;
  }
}
