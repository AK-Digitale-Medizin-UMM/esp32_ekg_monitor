/*
 * EKG-Sender (ESP-IDF v6.1, Target esp32)
 *
 * Tastet das EKG-Signal mit fester Rate ab, bündelt die Werte zu Paketen und
 * schickt sie als JSON (Protokoll v1, siehe pc-server/README.md) per HTTP POST
 * an den Server.
 *
 *   esp_timer (Abtastung, z. B. 250 Hz) ──Queue──▶ sender_task (HTTP POST)
 *
 * Einstellungen (WLAN, Server-URL, Pins, Testsignal):  idf.py menuconfig → "EKG Sender"
 * WLAN-Zugangsdaten landen nur in der lokalen sdkconfig (gitignored) –
 * nicht in sdkconfig.defaults eintragen.
 *
 * Verkabelung AD8232 (Standard):
 *   OUTPUT → GPIO 34   LO+ → GPIO 32   LO- → GPIO 33   3V3 → 3V3   GND → GND
 *
 * SICHERHEIT: Bei Messungen an Personen nur mit Akku/Powerbank betreiben,
 * nicht am Laptop, der am Netz hängt.
 */
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs_flash.h"

#define FS_HZ        CONFIG_EKG_SAMPLE_RATE_HZ
#define N_PER_PACKET CONFIG_EKG_SAMPLES_PER_PACKET
#define QUEUE_LEN    20   /* ≈ 2 s Puffer bei 250 Hz / 25 Samples */

static const char *TAG = "ekg";

typedef struct {
    uint32_t seq;
    uint32_t t0_us;
    bool lead_off;
    uint16_t samples[N_PER_PACKET];
} ecg_packet_t;

static QueueHandle_t s_packet_queue;
static EventGroupHandle_t s_wifi_events;
#define WIFI_CONNECTED_BIT BIT0

/* ------------------------------------------------------------------ WLAN */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT);
        ESP_LOGW(TAG, "WLAN getrennt, verbinde neu …");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "verbunden, IP " IPSTR, IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init(void)
{
    s_wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    wifi_config_t cfg = {0};
    strlcpy((char *)cfg.sta.ssid, CONFIG_EKG_WIFI_SSID, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, CONFIG_EKG_WIFI_PASSWORD, sizeof(cfg.sta.password));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));   /* weniger Latenz */
    ESP_ERROR_CHECK(esp_wifi_start());
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
static uint32_t s_dropped;

static void sample_timer_cb(void *arg)
{
    if (s_fill_pos == 0) {
        s_fill.t0_us = (uint32_t)esp_timer_get_time();
        s_fill.lead_off = false;
    }
    s_fill.samples[s_fill_pos++] = read_sample(s_sample_no++);
    s_fill.lead_off |= read_lead_off();

    if (s_fill_pos >= N_PER_PACKET) {
        /* nicht blockieren: wenn das Netz hängt, Paket verwerfen (Server sieht Lücke in seq) */
        if (xQueueSend(s_packet_queue, &s_fill, 0) != pdTRUE) {
            s_dropped++;
        }
        s_fill.seq++;
        s_fill_pos = 0;
    }
}

/* ------------------------------------------------------------------ Senden */

static int build_json(const ecg_packet_t *p, char *buf, size_t size)
{
    int len = snprintf(buf, size,
        "{\"v\":1,\"device_id\":\"%s\",\"seq\":%lu,\"fs\":%d,\"t0_us\":%lu,"
        "\"unit\":\"adc_raw\",\"adc_bits\":12,\"lead_off\":%s,\"samples\":[",
        CONFIG_EKG_DEVICE_ID, (unsigned long)p->seq, FS_HZ, (unsigned long)p->t0_us,
        p->lead_off ? "true" : "false");
    for (int i = 0; i < N_PER_PACKET && len < (int)size; i++) {
        len += snprintf(buf + len, size - len, i ? ",%u" : "%u", p->samples[i]);
    }
    if (len < (int)size) len += snprintf(buf + len, size - len, "]}");
    return len < (int)size ? len : -1;
}

static void sender_task(void *arg)
{
    static char json[192 + N_PER_PACKET * 6];
    ecg_packet_t pkt;

    esp_http_client_config_t cfg = {
        .url = CONFIG_EKG_SERVER_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 1000,
        .keep_alive_enable = true,   /* eine TCP-Verbindung für alle Pakete */
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");

    uint32_t sent = 0, failed = 0;
    while (true) {
        xQueueReceive(s_packet_queue, &pkt, portMAX_DELAY);
        xEventGroupWaitBits(s_wifi_events, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE, portMAX_DELAY);

        int len = build_json(&pkt, json, sizeof(json));
        if (len < 0) {
            ESP_LOGE(TAG, "JSON-Puffer zu klein");
            continue;
        }
        esp_http_client_set_post_field(client, json, len);
        esp_err_t err = esp_http_client_perform(client);
        int status = esp_http_client_get_status_code(client);

        if (err == ESP_OK && status == 202) {
            sent++;
        } else {
            failed++;
            ESP_LOGW(TAG, "POST fehlgeschlagen: %s, HTTP %d", esp_err_to_name(err), status);
            esp_http_client_close(client);   /* Verbindung beim nächsten Paket neu aufbauen */
        }
        if (pkt.seq % (FS_HZ / N_PER_PACKET * 10) == 0) {   /* ca. alle 10 s */
            ESP_LOGI(TAG, "gesendet %lu, Fehler %lu, verworfen %lu, lead_off=%d",
                     (unsigned long)sent, (unsigned long)failed, (unsigned long)s_dropped, pkt.lead_off);
        }
    }
}

/* ------------------------------------------------------------------ Start */

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    s_packet_queue = xQueueCreate(QUEUE_LEN, sizeof(ecg_packet_t));
    wifi_init();
    signal_init();

    xTaskCreate(sender_task, "ekg_sender", 6144, NULL, 5, NULL);

    const esp_timer_create_args_t timer_args = {.callback = sample_timer_cb, .name = "ekg_sample"};
    esp_timer_handle_t timer;
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, 1000000 / FS_HZ));

    ESP_LOGI(TAG, "%s: %d Hz, %d Samples/Paket → %s",
             CONFIG_EKG_DEVICE_ID, FS_HZ, N_PER_PACKET, CONFIG_EKG_SERVER_URL);
}
