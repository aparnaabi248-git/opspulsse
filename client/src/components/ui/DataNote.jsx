/**
 * DataNote
 * ========
 * A quiet, single-line note used for data-quality context — for example
 * "2,802 checks were expected but never recorded".
 *
 * This is deliberately NOT an <Alert>. The information is worth showing, but
 * a big coloured box on every dashboard made the app feel like it was
 * complaining. A muted note carries the same truth without the alarm, and it
 * never shouts at somebody who just wants to see if their site is up.
 */
export default function DataNote({ children, title }) {
  return (
    <p className="data-note">
      {title && <strong>{title}</strong>}
      <span>{children}</span>
    </p>
  );
}