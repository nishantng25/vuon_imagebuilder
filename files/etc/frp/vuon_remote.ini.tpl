[common]
server_addr = docker.itlems.com
server_port = 7000
token = {TOKEN}

[nvr_webui_{DEVICE_ID}]
type = http
local_ip = 127.0.0.1
local_port = 8080
custom_domains = {DEVICE_ID}.vuon.in
