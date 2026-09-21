// Browser code is constant. Credentials and labels travel only as CDP argument values.
export const SUBMIT_PASSWORD = `function(password) {
  const input = document.getElementById('encryption-password');
  input.value = password;
  input.form.requestSubmit();
  return true;
}`;

export const GRANT_APPEARED = `function(label) {
  return Array.from(document.querySelectorAll('.presence-agent'))
    .some(el => el.textContent === 'Agent: ' + label)
    && (document.getElementById('session-encryption')?.textContent ?? '').includes('MCP');
}`;

export function browserFunctionParams(objectId, functionDeclaration, values) {
  return {
    objectId,
    functionDeclaration,
    arguments: values.map((value) => ({ value })),
    returnByValue: true,
  };
}
