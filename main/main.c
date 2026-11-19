/*
 * EKG-Monitor (ESP-IDF v6.1, Target esp32)
 *
 * Tastet das EKG-Signal mit fester Rate ab, bündelt die Werte zu Paketen und
 * streamt sie als JSON (Protokoll v1) an lokale WebSocket-Clients.
 *
 *   esp_timer ──latest packet──▶ publisher task ──one work item──▶ HTTP task
 *
 * Einstellungen (Pins, Testsignal): idf.py menuconfig → "EKG Monitor"
 *
 * Verkabelung AD8232 (Standard):
 *   OUTPUT → GPIO 34   LO+ → GPIO 32   LO- → GPIO 33   3V3 → 3V3   GND → GND
 *
 * Offener Access Point: nur für Testsignale und Laboraufbauten ohne Personen.
 */
#include <inttypes.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs_flash.h"

#define FS_HZ        CONFIG_EKG_SAMPLE_RATE_HZ
#define N_PER_PACKET CONFIG_EKG_SAMPLES_PER_PACKET
#define AP_SSID      "ECG-Monitor"
#define AP_CLIENTS   3
#define HTTP_CLIENTS (2 * AP_CLIENTS) /* live WebSockets plus HTTP requests */
#define DEVICE_ID_MAX 64
#define SIGNAL_SOURCE (CONFIG_EKG_USE_TEST_SIGNAL ? "synthetic" : "device")

/* Disabled bools are absent from sdkconfig.h. */
#ifndef CONFIG_EKG_USE_TEST_SIGNAL
#define CONFIG_EKG_USE_TEST_SIGNAL 0
#endif

static const char *TAG = "ekg";

typedef struct {
    uint32_t seq;
    int64_t t0_us;
    bool lead_off;
    uint16_t samples[N_PER_PACKET];
} ecg_packet_t;

static QueueHandle_t s_packet_queue;
static httpd_handle_t s_http;

/* ------------------------------------------------------------------ WLAN */

static void wifi_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_t *ap = esp_netif_create_default_wifi_ap();
    ESP_ERROR_CHECK(ap ? ESP_OK : ESP_ERR_NO_MEM);

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    wifi_config_t cfg = {.ap = {
        .ssid = AP_SSID,
        .ssid_len = sizeof(AP_SSID) - 1,
        .channel = 1,
        .authmode = WIFI_AUTH_OPEN,
        .max_connection = AP_CLIENTS,
    }};
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &cfg));
    ESP_ERROR_CHECK(esp_wifi_start());

    esp_netif_ip_info_t ip;
    ESP_ERROR_CHECK(esp_netif_get_ip_info(ap, &ip));
    ESP_LOGI(TAG, "Open Wi-Fi: %s, viewer: http://" IPSTR "/", AP_SSID, IP2STR(&ip.ip));
}

/* ------------------------------------------------------------------ Signalquelle */

#if !CONFIG_EKG_USE_TEST_SIGNAL
static adc_oneshot_unit_handle_t s_adc;
static adc_channel_t s_adc_channel;
#endif

static void signal_init(void)
{
#if CONFIG_EKG_USE_TEST_SIGNAL
    ESP_LOGI(TAG, "Signalquelle: eingebautes Testsignal");
#else
    adc_unit_t unit;
    ESP_ERROR_CHECK(adc_oneshot_io_to_channel(CONFIG_EKG_ADC_GPIO, &unit, &s_adc_channel));
    adc_oneshot_unit_init_cfg_t unit_cfg = {.unit_id = unit};
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit_cfg, &s_adc));
    adc_oneshot_chan_cfg_t ch_cfg = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, s_adc_channel, &ch_cfg));
    ESP_LOGI(TAG, "Signalquelle: ADC an GPIO %d", CONFIG_EKG_ADC_GPIO);
#endif

#if CONFIG_EKG_LO_PLUS_GPIO >= 0 && CONFIG_EKG_LO_MINUS_GPIO >= 0
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << CONFIG_EKG_LO_PLUS_GPIO) | (1ULL << CONFIG_EKG_LO_MINUS_GPIO),
        .mode = GPIO_MODE_INPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&io));
#endif
}

#if CONFIG_EKG_USE_TEST_SIGNAL
/* Sehr einfaches EKG: P, QRS, T als Gauß-Wellen, 72/min, auf 12-bit-Skala */
static uint16_t test_signal_sample(uint32_t n)
{
    const float rr = 60.0f / 72.0f;
    float t = fmodf((float)n / FS_HZ, rr) - 0.3f;   /* R-Zacke bei 0,3 s im Zyklus */
    struct { float dt, amp, w; } waves[] = {
        {-0.20f, 0.15f, 0.025f}, {-0.035f, -0.12f, 0.010f}, {0.0f, 1.2f, 0.012f},
        {0.035f, -0.25f, 0.012f}, {0.28f, 0.30f, 0.050f},
    };
    float mv = 0;
    for (int i = 0; i < 5; i++) {
        float d = t - waves[i].dt;
        mv += waves[i].amp * expf(-(d * d) / (2 * waves[i].w * waves[i].w));
    }
    int v = 2048 + (int)(600.0f * mv);             /* 1 mV ≙ 600 Counts */
    return (uint16_t)(v < 0 ? 0 : v > 4095 ? 4095 : v);
}
#endif

static uint16_t read_sample(uint32_t n)
{
#if CONFIG_EKG_USE_TEST_SIGNAL
    return test_signal_sample(n);
#else
    int raw = 0;
    adc_oneshot_read(s_adc, s_adc_channel, &raw);
    return (uint16_t)raw;
#endif
}

static bool read_lead_off(void)
{
#if CONFIG_EKG_LO_PLUS_GPIO >= 0 && CONFIG_EKG_LO_MINUS_GPIO >= 0 && !CONFIG_EKG_USE_TEST_SIGNAL
    return gpio_get_level(CONFIG_EKG_LO_PLUS_GPIO) || gpio_get_level(CONFIG_EKG_LO_MINUS_GPIO);
#else
    return false;
#endif
}

/* ------------------------------------------------------------------ Abtastung */

static ecg_packet_t s_fill;     /* wird nur im Timer-Callback benutzt */
static uint32_t s_fill_pos;
static uint32_t s_sample_no;

static void sample_timer_cb(void *arg)
{
    if (s_fill_pos == 0) {
        s_fill.t0_us = esp_timer_get_time();
        s_fill.lead_off = false;
    }
    s_fill.samples[s_fill_pos++] = read_sample(s_sample_no++);
    s_fill.lead_off |= read_lead_off();

    if (s_fill_pos >= N_PER_PACKET) {
        /* Keep only the latest waiting packet; replacements are visible as seq gaps. */
        xQueueOverwrite(s_packet_queue, &s_fill);
        s_fill.seq++;
        s_fill_pos = 0;
    }
}

/* ------------------------------------------------------------------ HTTP / WebSocket */

extern const char viewer_html_start[] asm("_binary_viewer_html_start");

/* Owned by the HTTP task (including queued broadcast work). */
static ecg_packet_t s_latest;
static uint32_t s_packets;
static char s_unmatched_filter;

static esp_err_t viewer_get(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_sendstr(req, viewer_html_start);
}

static esp_err_t devices_get(httpd_req_t *req)
{
    char json[384];
    uint32_t lost = s_packets ? s_latest.seq + 1 - s_packets : 0;
    snprintf(json, sizeof(json),
        "[{\"device_id\":\"%s\",\"source\":\"%s\",\"fs\":%d,\"packets\":%" PRIu32
        ",\"samples\":%" PRIu64 ",\"lost_packets\":%" PRIu32 ",\"last_seq\":%" PRIu32
        ",\"lead_off\":%s,\"online\":%s}]",
        CONFIG_EKG_DEVICE_ID, SIGNAL_SOURCE, FS_HZ, s_packets, (uint64_t)s_packets * N_PER_PACKET,
        lost, s_latest.seq, s_latest.lead_off ? "true" : "false",
        s_packets && esp_timer_get_time() - s_latest.t0_us < 5000000 ? "true" : "false");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_sendstr(req, json);
}

static void free_filter(void *ctx)
{
    /* Static session marker, not heap-allocated. */
    (void)ctx;
}

static esp_err_t live_subscribe(httpd_req_t *req)
{
    char query[128];
    char device[DEVICE_ID_MAX + 1];
    size_t query_len = httpd_req_get_url_query_len(req);
    if (query_len != 0) {
        esp_err_t err = httpd_req_get_url_query_str(req, query, sizeof(query));
        if (err == ESP_OK) {
            err = httpd_query_key_value(query, "device_id", device, sizeof(device));
        }
        if (err != ESP_ERR_NOT_FOUND &&
            (err != ESP_OK || (*device && strcmp(device, CONFIG_EKG_DEVICE_ID) != 0))) {
            req->sess_ctx = &s_unmatched_filter;
            req->free_ctx = free_filter;
        }
    }
    return ESP_OK;
}

static esp_err_t live_get(httpd_req_t *req)
{
    /* This endpoint is send-only. ESP-IDF handles WebSocket control frames. */
    (void)req;
    return ESP_FAIL;
}

static int build_json(const ecg_packet_t *p, char *buf, size_t size)
{
    int len = snprintf(buf, size,
        "{\"v\":1,\"device_id\":\"%s\",\"seq\":%" PRIu32 ",\"fs\":%d,\"t0_us\":%" PRId64 ","
        "\"unit\":\"adc_raw\",\"adc_bits\":12,\"source\":\"%s\",\"lead_off\":%s,\"samples\":[",
        CONFIG_EKG_DEVICE_ID, p->seq, FS_HZ, p->t0_us, SIGNAL_SOURCE,
        p->lead_off ? "true" : "false");
    if (len < 0) return -1;
    for (int i = 0; i < N_PER_PACKET && len < (int)size; i++) {
        int n = snprintf(buf + len, size - len, i ? ",%u" : "%u", (unsigned)p->samples[i]);
        if (n < 0) return -1;
        len += n;
    }
    if ((size_t)len >= size || size - (size_t)len < sizeof("]}")) return -1;
    memcpy(buf + len, "]}", sizeof("]}"));
    return len + 2;
}

typedef struct {
    ecg_packet_t packet;
    TaskHandle_t publisher;
} broadcast_t;

static void broadcast(void *arg)
{
    broadcast_t *job = arg;
    s_latest = job->packet;
    s_packets++;

    size_t count = HTTP_CLIENTS;
    int fds[HTTP_CLIENTS];
    bool encoded = false;
    static char json[256 + N_PER_PACKET * 5];
    httpd_ws_frame_t frame = {.type = HTTPD_WS_TYPE_TEXT, .payload = (uint8_t *)json};
    if (httpd_get_client_list(s_http, &count, fds) == ESP_OK) {
        for (size_t i = 0; i < count; i++) {
            int fd = fds[i];
            if (httpd_ws_get_fd_info(s_http, fd) != HTTPD_WS_CLIENT_WEBSOCKET ||
                httpd_sess_get_ctx(s_http, fd) == &s_unmatched_filter) continue;
            if (!encoded) {
                int len = build_json(&s_latest, json, sizeof(json));
                if (len < 0) {
                    ESP_LOGE(TAG, "ECG packet exceeds JSON buffer");
                    break;
                }
                frame.len = len;
                encoded = true;
            }
            if (httpd_ws_send_frame_async(s_http, fd, &frame) != ESP_OK) {
                httpd_sess_trigger_close(s_http, fd);
            }
        }
    }
    xTaskNotifyGive(job->publisher);
}

static void publisher_task(void *arg)
{
    broadcast_t job = {.publisher = xTaskGetCurrentTaskHandle()};
    while (true) {
        xQueueReceive(s_packet_queue, &job.packet, portMAX_DELAY);
        if (httpd_queue_work(s_http, broadcast, &job) == ESP_OK) {
            /* The HTTP task borrows job until broadcast returns ownership. */
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        } else {
            vTaskDelay(1);
        }
    }
}

static void server_init(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.max_open_sockets = HTTP_CLIENTS;
    cfg.lru_purge_enable = true;
    cfg.recv_wait_timeout = 1;
    cfg.send_wait_timeout = 1;
    ESP_ERROR_CHECK(httpd_start(&s_http, &cfg));

    static const httpd_uri_t routes[] = {
        {.uri = "/", .method = HTTP_GET, .handler = viewer_get},
        {.uri = "/api/v1/devices", .method = HTTP_GET, .handler = devices_get},
        {.uri = "/ws/live", .method = HTTP_GET, .handler = live_get, .is_websocket = true,
         .ws_post_handshake_cb = live_subscribe},
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        ESP_ERROR_CHECK(httpd_register_uri_handler(s_http, &routes[i]));
    }
}

/* ------------------------------------------------------------------ Start */

void app_main(void)
{
    const char *id = CONFIG_EKG_DEVICE_ID;
    size_t id_len = strlen(id);
    if (!id_len || id_len > DEVICE_ID_MAX ||
        strspn(id, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-") != id_len) {
        ESP_LOGE(TAG, "Invalid device ID; see EKG Monitor in menuconfig");
        return;
    }
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    s_packet_queue = xQueueCreate(1, sizeof(ecg_packet_t));
    ESP_ERROR_CHECK(s_packet_queue ? ESP_OK : ESP_ERR_NO_MEM);
    signal_init();
    wifi_init();
    server_init();

    ESP_ERROR_CHECK(xTaskCreate(publisher_task, "ekg_publish", 3072, NULL, 5, NULL) == pdPASS
                    ? ESP_OK : ESP_ERR_NO_MEM);

    const esp_timer_create_args_t timer_args = {.callback = sample_timer_cb, .name = "ekg_sample"};
    esp_timer_handle_t timer;
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, 1000000 / FS_HZ));

    ESP_LOGI(TAG, "%s: %d Hz, %d samples/packet", id, FS_HZ, N_PER_PACKET);
}
