export function failure(report, error, stage) {
  report.passed = false;
  const detail = { stage, name: error.name, code: error.code, operator: error.operator };
  const label = String(error.message ?? '').split('\n')[0];
  if (/^(PROFILE-|AD-OBS-)/.test(label) && label.length <= 180) detail.assertion_label = label;
  detail.locations = String(error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line) && /android-profile-smoke/.test(line))
    .slice(0, 8);
  if (report.failure) {
    report.secondary_errors ??= [];
    report.secondary_errors.push(detail);
  } else report.failure = detail;
}
