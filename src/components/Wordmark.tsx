import { Link } from "react-router-dom";

export function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label="shell.online home">
      shell<i>.online</i>
    </Link>
  );
}
