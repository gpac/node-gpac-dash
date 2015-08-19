#!/bin/sh
cat dashcast-log.txt  | grep Opening > dashcast-log-segment.txt

cat mp4box-live-log.txt  | grep Closing > mp4box-live-log-segment.txt

cat server-log.txt  | grep Request > server-log-segment.txt

cat client-log.txt | grep GET > client-log-get.txt