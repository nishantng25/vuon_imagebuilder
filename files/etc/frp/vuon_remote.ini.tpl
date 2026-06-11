[common]
server_addr = docker.itlems.com
server_port = 7000
token = {TOKEN}
# Keep the long-lived control connection alive through idle-TCP-timeout
# middleboxes (carrier NAT / reverse proxies). Without these, the default
# 30s heartbeat let the control conn get reaped ~every 70s, causing the
# tunnel to flap (control writer is closing -> reconnect). 10s heartbeat
# keeps it busy; 30s timeout = faster recovery; login_fail_exit=false lets
# frpc keep retrying instead of exiting on a transient login failure.
tcp_mux = true
heartbeat_interval = 10
heartbeat_timeout = 30
login_fail_exit = false

[nvr_webui_{DEVICE_ID}]
type = http
local_ip = 127.0.0.1
local_port = 8080
custom_domains = {DEVICE_ID}.vuon.in
