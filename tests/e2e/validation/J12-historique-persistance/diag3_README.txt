J12 diag3 - stoppedAtMs divergence
Cause: simulation used Date.now() independently on each device (CDP eval). 
Behavior in app: persistStopIfNeeded prefers v.localStopInfo.stopAtMs/actualMs or v.stop.stopAtMs/actualMs; falls back to nowMs(). For coordinated STOP, Master should provide canonical stop time so peers write identical stoppedAtMs.
Conclusion: divergence is expected from simulation, not a propagation defect. No code change required.
