#include <ApplicationServices/ApplicationServices.h>
#include <arpa/inet.h>
#include <errno.h>
#include <math.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static bool left_button_down = false;

static void post_mouse_event(const char *type, double normalized_x, double normalized_y) {
    CGRect screen = CGDisplayBounds(CGMainDisplayID());
    CGFloat x = screen.origin.x + fmax(0.0, fmin(1.0, normalized_x)) * screen.size.width;
    CGFloat y = screen.origin.y + fmax(0.0, fmin(1.0, normalized_y)) * screen.size.height;
    CGEventType event_type;

    if (strcmp(type, "down") == 0) {
        event_type = kCGEventLeftMouseDown;
        left_button_down = true;
    } else if (strcmp(type, "up") == 0) {
        event_type = kCGEventLeftMouseUp;
        left_button_down = false;
    } else if (strcmp(type, "move") == 0) {
        event_type = left_button_down ? kCGEventLeftMouseDragged : kCGEventMouseMoved;
    } else {
        return;
    }

    CGEventRef event = CGEventCreateMouseEvent(NULL, event_type, CGPointMake(x, y), kCGMouseButtonLeft);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void send_response(int client, const char *status, const char *body) {
    char response[1024];
    size_t body_length = strlen(body);
    int length = snprintf(
        response,
        sizeof(response),
        "HTTP/1.1 %s\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %zu\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
        "Connection: close\r\n\r\n%s",
        status,
        body_length,
        body
    );
    write(client, response, (size_t)length);
}

static void handle_request(int client) {
    char request[65536] = {0};
    size_t received = 0;
    char *body = NULL;
    size_t expected_length = 0;

    // Browser fetch may split headers and JSON body across packets.
    while (received < sizeof(request) - 1) {
        ssize_t count = read(client, request + received, sizeof(request) - 1 - received);
        if (count <= 0) return;
        received += (size_t)count;
        request[received] = '\0';

        if (!body && (body = strstr(request, "\r\n\r\n"))) {
            char *content_length = strstr(request, "Content-Length:");
            expected_length = content_length ? (size_t)strtoul(content_length + 15, NULL, 10) : 0;
        }
        if (body && received >= (size_t)(body + 4 - request) + expected_length) break;
    }

    if (strncmp(request, "GET /status", 11) == 0) {
        send_response(client, "200 OK", AXIsProcessTrusted() ? "{\"accessibility\":true}" : "{\"accessibility\":false}");
        return;
    }

    if (strncmp(request, "OPTIONS", 7) == 0) {
        send_response(client, "204 No Content", "");
        return;
    }

    if (body) {
        char type[16] = {0};
        double x = 0.5;
        double y = 0.5;
        sscanf(body + 4, "{\"type\":\"%15[^\"]\",\"x\":%lf,\"y\":%lf", type, &x, &y);
        post_mouse_event(type, x, y);
    }

    send_response(client, "204 No Content", "");
}

int main(void) {
    int server = socket(AF_INET, SOCK_STREAM, 0);
    if (server < 0) return 1;

    int reuse = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(8765);

    if (bind(server, (struct sockaddr *)&address, sizeof(address)) < 0) {
        perror("bind");
        close(server);
        return 1;
    }
    if (listen(server, 16) < 0) {
        perror("listen");
        close(server);
        return 1;
    }

    printf("Gesture mouse helper listening on http://127.0.0.1:8765\n");
    fflush(stdout);
    while (1) {
        int client = accept(server, NULL, NULL);
        if (client >= 0) {
            handle_request(client);
            close(client);
        }
    }
}
