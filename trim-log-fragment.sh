#!/bin/sh
cat dashcast-log.txt  | grep fragment > dashcast-log-fragment.txt

cat mp4box-live-log.txt  | grep flushing > mp4box-live-log-fragment.txt

cat server-log.txt  | grep fragment > server-log-fragment.txt

cat client-log.txt | grep Chunk | grep -v \"0\" | grep -v \"8\" > client-log-chunk.txt

paste mp4box-live-log-fragment.txt server-log-fragment.txt client-log-chunk.txt > log-fragment.txt