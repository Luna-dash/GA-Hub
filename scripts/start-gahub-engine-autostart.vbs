' GA-Hub engine autostart (deployed copy lives in the user's Startup folder).
' Runs scripts\start-gahub-engine.cmd fully hidden at logon; see that file for
' why the engine is started outside the ga-hub-sidecar parent chain.
CreateObject("WScript.Shell").Run """D:\study\GA-Hub\scripts\start-gahub-engine.cmd""", 0, False
