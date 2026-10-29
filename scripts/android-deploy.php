<?php
declare(strict_types=1);
// MultiCam: deploy debug APK to selected lab tablets, sequentially.
// Mask bits: 1,2,4,8. 15 selects all four.
$devices = [1=>'61cc29567d91',2=>'61d54bba7d91',4=>'62614ac67d91',8=>'c0d8514d7d87'];
if ($argc !== 2 || !ctype_digit($argv[1]) || (int)$argv[1] < 1 || (int)$argv[1] > 15) exit(2);
$mask = (int)$argv[1];
$apk = realpath(__DIR__.'/../app/platforms/android/app/build/outputs/apk/debug/app-debug.apk');
if (!$apk || !is_file($apk)) { fwrite(STDERR, "APK absent\n"); exit(2); }
function adb(array $args): array {
    $p = proc_open(array_merge(['/usr/bin/adb'], $args), [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes);
    if (!is_resource($p)) return [127,'','ADB failed'];
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); fclose($pipes[1]);
    $err = stream_get_contents($pipes[2]); fclose($pipes[2]);
    return [proc_close($p), trim($out), trim($err)];
}
[$code,$out] = adb(['devices']);
if ($code !== 0) exit(2);
$available = [];
foreach (explode("\n", $out) as $line) {
    if (preg_match('/^([a-zA-Z0-9._:-]+)\s+device\s*$/', trim($line), $m)) $available[$m[1]]=true;
}
$failed = 0;
foreach ($devices as $bit=>$serial) {
    if (!($mask & $bit)) continue;
    if (!isset($available[$serial])) { echo "$serial FAIL disconnected\n"; ++$failed; continue; }
    [$status,$stdout,$stderr] = adb(['-s',$serial,'install','-r',$apk]);
    if ($status === 0 && str_contains($stdout,'Success')) echo "$serial PASS\n";
    else { echo "$serial FAIL $stdout $stderr\n"; ++$failed; }
}
echo "Failed: $failed\n";
exit($failed ? 1 : 0);
