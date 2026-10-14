"""
CloudOps NOC Monitoring Dashboard — Flask Backend
Production-grade metrics server using psutil + deque ring buffer
"""

import os
import time
import logging
import platform
import socket
import threading
import urllib.request
from collections import deque
from datetime import datetime, timezone
from flask import Flask, jsonify, render_template
import psutil

# ─── Configuration ────────────────────────────────────────────────────────────
HISTORY_LENGTH   = 90        # 30 s × 2 s = 90 data points for 3-min window
UPDATE_INTERVAL  = 2         # seconds between background collection
ALERT_LOG        = "logs/alerts.log"

CPU_WARN         = 70
CPU_CRIT         = 85
MEM_WARN         = 75
MEM_CRIT         = 90
DISK_WARN        = 80
DISK_CRIT        = 90

# ─── Logging ──────────────────────────────────────────────────────────────────
os.makedirs("logs", exist_ok=True)
logging.basicConfig(
    filename=ALERT_LOG,
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
alert_logger = logging.getLogger("alerts")

# ─── State ────────────────────────────────────────────────────────────────────
cpu_history     = deque(maxlen=HISTORY_LENGTH)
mem_history     = deque(maxlen=HISTORY_LENGTH)
disk_history    = deque(maxlen=HISTORY_LENGTH)
net_in_history  = deque(maxlen=HISTORY_LENGTH)
net_out_history = deque(maxlen=HISTORY_LENGTH)
ts_history      = deque(maxlen=HISTORY_LENGTH)

incidents        = deque(maxlen=50)
alerts           = deque(maxlen=100)

_last_net_io     = None
_prev_net_bytes  = (0, 0)

# ─── Helpers ──────────────────────────────────────────────────────────────────

def now_iso():
    return datetime.now().strftime("%H:%M:%S")


def get_public_ip():
    try:
        with urllib.request.urlopen("https://api.ipify.org", timeout=3) as r:
            return r.read().decode()
    except Exception:
        return "N/A"


def severity(val, warn, crit):
    if val >= crit:
        return "CRITICAL"
    if val >= warn:
        return "WARNING"
    return "OK"


def status_color(sev):
    return {"OK": "green", "WARNING": "orange", "CRITICAL": "red"}.get(sev, "green")


def check_service(name):
    """Check if a systemd service is active (Linux only)."""
    try:
        result = os.popen(f"systemctl is-active {name} 2>/dev/null").read().strip()
        if result == "active":
            return "active"
        if result in ("inactive", "failed"):
            return "down"
        return "degraded"
    except Exception:
        return "unknown"


def log_alert(level, message):
    entry = {"time": now_iso(), "level": level, "message": message}
    alerts.appendleft(entry)
    if level == "CRITICAL":
        alert_logger.critical(message)
    elif level == "WARNING":
        alert_logger.warning(message)
    else:
        alert_logger.info(message)


def add_incident(severity_label, message):
    incidents.appendleft({"time": now_iso(), "severity": severity_label, "message": message})


# ─── Collector Thread ──────────────────────────────────────────────────────────

def collect_metrics():
    global _prev_net_bytes
    _prev_alert_cpu   = "OK"
    _prev_alert_mem   = "OK"
    _prev_alert_disk  = "OK"

    # warm-up read
    psutil.cpu_percent(interval=None)
    net_init = psutil.net_io_counters()
    _prev_net_bytes = (net_init.bytes_recv, net_init.bytes_sent)

    while True:
        ts = now_iso()

        # CPU
        cpu = psutil.cpu_percent(interval=None)

        # Memory
        mem = psutil.virtual_memory()
        mem_pct = mem.percent

        # Disk
        disk = psutil.disk_usage("/")
        disk_pct = disk.percent

        # Network (MB/s delta)
        net = psutil.net_io_counters()
        bytes_in  = max(0, net.bytes_recv - _prev_net_bytes[0])
        bytes_out = max(0, net.bytes_sent - _prev_net_bytes[1])
        _prev_net_bytes = (net.bytes_recv, net.bytes_sent)
        mb_in  = round(bytes_in  / 1_048_576 / UPDATE_INTERVAL, 3)
        mb_out = round(bytes_out / 1_048_576 / UPDATE_INTERVAL, 3)

        # Push to history
        cpu_history.append(cpu)
        mem_history.append(mem_pct)
        disk_history.append(disk_pct)
        net_in_history.append(mb_in)
        net_out_history.append(mb_out)
        ts_history.append(ts)

        # ── Alert engine ───────────────────────────────────────────────────────
        cpu_sev  = severity(cpu,      CPU_WARN,  CPU_CRIT)
        mem_sev  = severity(mem_pct,  MEM_WARN,  MEM_CRIT)
        disk_sev = severity(disk_pct, DISK_WARN, DISK_CRIT)

        if cpu_sev != _prev_alert_cpu:
            if cpu_sev == "CRITICAL":
                log_alert("CRITICAL", f"CPU critical: {cpu:.1f}%")
                add_incident("CRITICAL", f"CPU exceeded {CPU_CRIT}% threshold ({cpu:.1f}%)")
            elif cpu_sev == "WARNING":
                log_alert("WARNING", f"CPU warning: {cpu:.1f}%")
                add_incident("WARNING", f"CPU exceeded {CPU_WARN}% threshold ({cpu:.1f}%)")
            else:
                log_alert("INFO", f"CPU recovered: {cpu:.1f}%")
                add_incident("OK", f"CPU recovered to {cpu:.1f}%")
            _prev_alert_cpu = cpu_sev

        if mem_sev != _prev_alert_mem:
            if mem_sev == "CRITICAL":
                log_alert("CRITICAL", f"Memory critical: {mem_pct:.1f}%")
                add_incident("CRITICAL", f"Memory spike — {mem_pct:.1f}% used")
            elif mem_sev == "WARNING":
                log_alert("WARNING", f"Memory warning: {mem_pct:.1f}%")
                add_incident("WARNING", f"Memory warning — {mem_pct:.1f}% used")
            else:
                log_alert("INFO", f"Memory recovered: {mem_pct:.1f}%")
                add_incident("OK", "Memory usage normalised")
            _prev_alert_mem = mem_sev

        if disk_sev != _prev_alert_disk:
            if disk_sev != "OK":
                log_alert(disk_sev, f"Disk {disk_sev.lower()}: {disk_pct:.1f}%")
                add_incident(disk_sev, f"Disk at {disk_pct:.1f}%")
            _prev_alert_disk = disk_sev

        time.sleep(UPDATE_INTERVAL)


# ─── Flask App ────────────────────────────────────────────────────────────────
app = Flask(__name__)

PUBLIC_IP = get_public_ip()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/metrics")
def metrics():
    try:
        cpu  = list(cpu_history)
        mem  = list(mem_history)
        disk = list(disk_history)
        ts   = list(ts_history)

        cpu_cur  = cpu[-1]  if cpu  else 0
        mem_cur  = mem[-1]  if mem  else 0
        disk_cur = disk[-1] if disk else 0

        vmem    = psutil.virtual_memory()
        swap    = psutil.swap_memory()
        load    = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)
        procs   = len(psutil.pids())
        uptime  = int(time.time() - psutil.boot_time())
        uptime_str = f"{uptime//86400}d {(uptime%86400)//3600}h {(uptime%3600)//60}m"

        cpu_sev  = severity(cpu_cur,  CPU_WARN,  CPU_CRIT)
        mem_sev  = severity(mem_cur,  MEM_WARN,  MEM_CRIT)
        disk_sev = severity(disk_cur, DISK_WARN, DISK_CRIT)

        # Health score
        deductions = 0
        if cpu_sev  == "WARNING":  deductions += 5
        if cpu_sev  == "CRITICAL": deductions += 20
        if mem_sev  == "WARNING":  deductions += 5
        if mem_sev  == "CRITICAL": deductions += 20
        if disk_sev == "WARNING":  deductions += 3
        if disk_sev == "CRITICAL": deductions += 15
        health_score = max(0, 100 - deductions)

        # Overall incident severity
        active_sevs = [cpu_sev, mem_sev, disk_sev]
        if "CRITICAL" in active_sevs:
            overall_incident = "CRITICAL"
        elif "WARNING" in active_sevs:
            overall_incident = "WARNING"
        else:
            overall_incident = "NONE"

        try:
            temp_data = psutil.sensors_temperatures()
            temp_list = []
            for sensor, readings in (temp_data or {}).items():
                for r in readings:
                    temp_list.append(r.current)
            temperature = round(sum(temp_list) / len(temp_list), 1) if temp_list else None
        except Exception:
            temperature = None

        return jsonify({
            "timestamp": now_iso(),
            "server": {
                "hostname": socket.gethostname(),
                "os": platform.system() + " " + platform.release(),
                "public_ip": PUBLIC_IP,
            },
            "current": {
                "cpu":  {"value": round(cpu_cur, 1),  "severity": cpu_sev},
                "mem":  {"value": round(mem_cur, 1),  "severity": mem_sev,
                         "used_gb": round(vmem.used/1e9,1), "total_gb": round(vmem.total/1e9,1)},
                "disk": {"value": round(disk_cur, 1), "severity": disk_sev},
                "net_in":  round(list(net_in_history)[-1],  3) if net_in_history  else 0,
                "net_out": round(list(net_out_history)[-1], 3) if net_out_history else 0,
            },
            "history": {
                "timestamps": ts,
                "cpu":        cpu,
                "mem":        mem,
                "disk":       disk,
                "net_in":     list(net_in_history),
                "net_out":    list(net_out_history),
            },
            "system": {
                "load_avg":    round(load[0], 2),
                "load_5":      round(load[1], 2),
                "load_15":     round(load[2], 2),
                "processes":   procs,
                "swap_pct":    round(swap.percent, 1),
                "uptime":      uptime_str,
                "temperature": temperature,
            },
            "health": {
                "score":    health_score,
                "incident": overall_incident,
            },
            "incidents": list(incidents)[:20],
            "alerts":    list(alerts)[:30],
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/services")
def services():
    def probe(name, display, port=None):
        status = check_service(name)
        # fallback: check if a process with that name exists
        if status == "unknown":
            running = any(
                name in (p.name() or "").lower()
                for p in psutil.process_iter(["name"])
            )
            status = "active" if running else "down"
        # optionally probe port
        if port and status == "active":
            try:
                s = socket.create_connection(("127.0.0.1", port), timeout=1)
                s.close()
            except Exception:
                status = "degraded"
        return {"name": display, "key": name, "status": status}

    svcs = [
        probe("nginx",     "Nginx",           port=80),
        probe("flask",     "Flask API",       port=5000),
        probe("ssh",       "SSH",             port=22),
        probe("monitor",   "Monitor Agent"),
        probe("postgresql","PostgreSQL",      port=5432),
        probe("redis",     "Redis",           port=6379),
    ]
    return jsonify({"services": svcs})


@app.route("/network")
def network():
    net = psutil.net_io_counters()
    conns = len(psutil.net_connections())
    return jsonify({
        "mb_in":       round(list(net_in_history)[-1],  3) if net_in_history  else 0,
        "mb_out":      round(list(net_out_history)[-1], 3) if net_out_history else 0,
        "connections": conns,
        "bytes_recv":  net.bytes_recv,
        "bytes_sent":  net.bytes_sent,
        "packets_recv": net.packets_recv,
        "packets_sent": net.packets_sent,
        "errors_in":   net.errin,
        "errors_out":  net.errout,
        "history_in":  list(net_in_history),
        "history_out": list(net_out_history),
    })


# ─── Bootstrap ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    t = threading.Thread(target=collect_metrics, daemon=True)
    t.start()
    # let the collector warm up
    time.sleep(2.5)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
